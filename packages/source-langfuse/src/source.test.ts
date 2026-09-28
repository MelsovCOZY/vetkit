// Tests for createLangfuseSource (bead mol-yxn.5), written from the acceptance criteria:
// - `createLangfuseSource(...).doRead()` yields one NormalizedTrace per Langfuse trace, with
//   messages assembled from GENERATION observations in start-time order, provenance
//   ('langfuse.trace.id' / 'langfuse.observation.id' of the last generation) recorded as
//   attributes on that generation's span, dialect 'langfuse', completeness.contentCaptured=false
//   when input/output are null (case 'redacted content').
// - Pagination over 2 pages via a fake fetch (case 'pagination').
// - Auth failure (401/403) yields a VetError code SOURCE_AUTH thrown at first read, not a
//   silent empty iterator (case 'auth').
// Plus two edge cases from the bead's "Edge cases" section, testing the SOURCE_UNREACHABLE
// code this bead adds: a 429 exhausted after 3 retries, and a trace with zero GENERATION
// observations.
//
// fetch is injected (options.fetch); no live Langfuse calls. Credentials are read from env var
// NAMES via process.env, never literals.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { VetError } from '@vetkit/spec';
import { createLangfuseSource } from './source.ts';

const BASE_URL_ENV = 'TEST_LANGFUSE_BASE_URL';
const PUBLIC_KEY_ENV = 'TEST_LANGFUSE_PUBLIC_KEY';
const SECRET_KEY_ENV = 'TEST_LANGFUSE_SECRET_KEY';

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: () => Promise.resolve(body),
  };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

beforeEach(() => {
  process.env[BASE_URL_ENV] = 'https://langfuse.example.com';
  process.env[PUBLIC_KEY_ENV] = 'pk-lf-test';
  process.env[SECRET_KEY_ENV] = 'sk-lf-test';
});

afterEach(() => {
  delete process.env[BASE_URL_ENV];
  delete process.env[PUBLIC_KEY_ENV];
  delete process.env[SECRET_KEY_ENV];
});

describe('createLangfuseSource', () => {
  test('id and capabilities match the SourceV1 contract', () => {
    const source = createLangfuseSource({
      baseUrlEnv: BASE_URL_ENV,
      publicKeyEnv: PUBLIC_KEY_ENV,
      secretKeyEnv: SECRET_KEY_ENV,
    });

    expect(source.specVersion).toBe('v1');
    expect(source.id).toBe('langfuse/api');
    expect(source.capabilities).toEqual({ streaming: true, content: 'maybe' });
  });

  test('case: full trace — messages in start-time order, provenance on the last generation span', async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url.includes('/api/public/traces?')) {
        return jsonResponse(200, {
          data: [{ id: 'trace-1' }],
          meta: { page: 1, limit: 50, totalItems: 1, totalPages: 1 },
        });
      }
      return jsonResponse(200, {
        id: 'trace-1',
        observations: [
          {
            id: 'obs-2',
            type: 'GENERATION',
            input: 'second question',
            output: 'second answer',
            startTime: '2026-01-01T00:01:00.000Z',
          },
          {
            id: 'obs-1',
            type: 'GENERATION',
            input: 'first question',
            output: 'first answer',
            startTime: '2026-01-01T00:00:00.000Z',
          },
        ],
      });
    });

    const source = createLangfuseSource({
      baseUrlEnv: BASE_URL_ENV,
      publicKeyEnv: PUBLIC_KEY_ENV,
      secretKeyEnv: SECRET_KEY_ENV,
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    const traces = await collect(source.doRead({}));

    expect(traces).toHaveLength(1);
    const trace = traces[0];
    expect(trace?.traceId).toBe('trace-1');
    expect(trace?.dialect).toBe('langfuse');
    expect(trace?.messages).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'first question' }] },
      { role: 'assistant', parts: [{ type: 'text', content: 'first answer' }] },
      { role: 'user', parts: [{ type: 'text', content: 'second question' }] },
      { role: 'assistant', parts: [{ type: 'text', content: 'second answer' }] },
    ]);
    expect(trace?.completeness).toEqual({
      contentCaptured: true,
      truncated: false,
      missingParents: false,
    });
    const lastSpan = trace?.spans.at(-1);
    expect(lastSpan?.attributes).toEqual({
      'langfuse.trace.id': 'trace-1',
      'langfuse.observation.id': 'obs-2',
    });
  });

  test('case: redacted content — null input/output mark completeness.contentCaptured=false', async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url.includes('/api/public/traces?')) {
        return jsonResponse(200, {
          data: [{ id: 'trace-redacted' }],
          meta: { page: 1, limit: 50, totalItems: 1, totalPages: 1 },
        });
      }
      return jsonResponse(200, {
        id: 'trace-redacted',
        observations: [
          {
            id: 'obs-1',
            type: 'GENERATION',
            input: null,
            output: null,
            startTime: '2026-01-01T00:00:00.000Z',
          },
        ],
      });
    });

    const source = createLangfuseSource({
      baseUrlEnv: BASE_URL_ENV,
      publicKeyEnv: PUBLIC_KEY_ENV,
      secretKeyEnv: SECRET_KEY_ENV,
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    const traces = await collect(source.doRead({}));

    expect(traces).toHaveLength(1);
    expect(traces[0]?.messages).toEqual([]);
    expect(traces[0]?.completeness.contentCaptured).toBe(false);
  });

  test('case: pagination — 2 pages via fake fetch', async () => {
    const seenUrls: string[] = [];
    const fetch = vi.fn(async (url: string) => {
      seenUrls.push(url);
      if (url.includes('page=1')) {
        return jsonResponse(200, {
          data: [{ id: 'trace-a' }],
          meta: { page: 1, limit: 50, totalItems: 2, totalPages: 2 },
        });
      }
      if (url.includes('page=2')) {
        return jsonResponse(200, {
          data: [{ id: 'trace-b' }],
          meta: { page: 2, limit: 50, totalItems: 2, totalPages: 2 },
        });
      }
      return jsonResponse(200, {
        id: url.includes('trace-a') ? 'trace-a' : 'trace-b',
        observations: [],
      });
    });

    const source = createLangfuseSource({
      baseUrlEnv: BASE_URL_ENV,
      publicKeyEnv: PUBLIC_KEY_ENV,
      secretKeyEnv: SECRET_KEY_ENV,
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    const traces = await collect(source.doRead({}));

    expect(traces.map((t) => t.traceId)).toEqual(['trace-a', 'trace-b']);
    expect(seenUrls.some((u) => u.includes('/api/public/traces?') && u.includes('page=1'))).toBe(
      true,
    );
    expect(seenUrls.some((u) => u.includes('/api/public/traces?') && u.includes('page=2'))).toBe(
      true,
    );
  });

  test('case: auth — a 401 yields VetError SOURCE_AUTH thrown at first read, not an empty iterator', async () => {
    const fetch = vi.fn(async () => jsonResponse(401, { message: 'unauthorized' }));

    const source = createLangfuseSource({
      baseUrlEnv: BASE_URL_ENV,
      publicKeyEnv: PUBLIC_KEY_ENV,
      secretKeyEnv: SECRET_KEY_ENV,
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    const iterator = source.doRead({})[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toSatisfy((err: unknown) => {
      expect(VetError.isInstance(err)).toBe(true);
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      expect((err as VetError).code).toBe('SOURCE_AUTH');
      return true;
    });
  });

  test('edge case: a 429 exhausted after 3 retries throws SOURCE_UNREACHABLE', async () => {
    let calls = 0;
    const fetch = vi.fn(async () => {
      calls += 1;
      return jsonResponse(429, { message: 'rate limited' }, { 'retry-after': '1' });
    });
    const sleep = vi.fn(async () => undefined);

    const source = createLangfuseSource({
      baseUrlEnv: BASE_URL_ENV,
      publicKeyEnv: PUBLIC_KEY_ENV,
      secretKeyEnv: SECRET_KEY_ENV,
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      fetch: fetch as unknown as typeof globalThis.fetch,
      sleep,
    });

    const iterator = source.doRead({})[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toSatisfy((err: unknown) => {
      expect(VetError.isInstance(err)).toBe(true);
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      expect((err as VetError).code).toBe('SOURCE_UNREACHABLE');
      return true;
    });
    expect(calls).toBe(4);
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  test('edge case: zero GENERATION observations yields messages=[] with contentCaptured=false', async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url.includes('/api/public/traces?')) {
        return jsonResponse(200, {
          data: [{ id: 'trace-empty' }],
          meta: { page: 1, limit: 50, totalItems: 1, totalPages: 1 },
        });
      }
      return jsonResponse(200, {
        id: 'trace-empty',
        observations: [
          { id: 'span-1', type: 'SPAN', input: 'x', output: 'y', startTime: '2026-01-01T00:00:00.000Z' },
        ],
      });
    });

    const source = createLangfuseSource({
      baseUrlEnv: BASE_URL_ENV,
      publicKeyEnv: PUBLIC_KEY_ENV,
      secretKeyEnv: SECRET_KEY_ENV,
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    const traces = await collect(source.doRead({}));

    expect(traces).toHaveLength(1);
    expect(traces[0]?.messages).toEqual([]);
    expect(traces[0]?.spans).toEqual([]);
    expect(traces[0]?.completeness.contentCaptured).toBe(false);
  });
});
