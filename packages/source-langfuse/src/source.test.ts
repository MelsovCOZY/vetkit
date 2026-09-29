// Tests for createLangfuseSource:
// - `createLangfuseSource(...).doRead()` yields one NormalizedTrace per Langfuse trace, with
//   messages assembled from GENERATION observations in start-time order, provenance
//   ('langfuse.trace.id' / 'langfuse.observation.id' of the last generation) recorded as
//   attributes on that generation's span, dialect 'langfuse', completeness.contentCaptured=false
//   when input/output are null (case 'redacted content').
// - Cursor pagination over 2 pages via a fake fetch (case 'pagination'), an empty page, and a
//   trace whose observations straddle two pages.
// - Auth failure (401/403) yields a VetError code SOURCE_AUTH thrown at first read, not a
//   silent empty iterator (case 'auth').
// - Two edge cases: SOURCE_UNREACHABLE after a 429 exhausted after 3 retries, and a trace with
//   zero GENERATION observations.
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
    const fetch = vi.fn(async () =>
      jsonResponse(200, {
        data: [
          {
            id: 'obs-2',
            traceId: 'trace-1',
            type: 'GENERATION',
            input: 'second question',
            output: 'second answer',
            startTime: '2026-01-01T00:01:00.000Z',
          },
          {
            id: 'obs-1',
            traceId: 'trace-1',
            type: 'GENERATION',
            input: 'first question',
            output: 'first answer',
            startTime: '2026-01-01T00:00:00.000Z',
          },
        ],
        meta: {},
      }),
    );

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
    const fetch = vi.fn(async () =>
      jsonResponse(200, {
        data: [
          {
            id: 'obs-1',
            traceId: 'trace-redacted',
            type: 'GENERATION',
            input: null,
            output: null,
            startTime: '2026-01-01T00:00:00.000Z',
          },
        ],
        meta: {},
      }),
    );

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

  test('case: pagination — follows meta.cursor across 2 pages via /api/public/v2/observations', async () => {
    const seenUrls: string[] = [];
    const fetch = vi.fn(async (url: string) => {
      seenUrls.push(url);
      if (!url.includes('cursor=')) {
        return jsonResponse(200, {
          data: [
            {
              id: 'obs-a',
              traceId: 'trace-a',
              type: 'GENERATION',
              input: 'qa',
              output: 'aa',
              startTime: '2026-01-01T00:00:00.000Z',
            },
          ],
          meta: { cursor: 'CURSOR-2' },
        });
      }
      return jsonResponse(200, {
        data: [
          {
            id: 'obs-b',
            traceId: 'trace-b',
            type: 'GENERATION',
            input: 'qb',
            output: 'ab',
            startTime: '2026-01-01T00:00:01.000Z',
          },
        ],
        meta: {},
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
    expect(seenUrls).toHaveLength(2);
    expect(seenUrls[0]).toContain('/api/public/v2/observations?');
    expect(seenUrls[0]).toContain('limit=50');
    expect(seenUrls[1]).toContain('cursor=CURSOR-2');
    expect(seenUrls.some((u) => u.includes('/api/public/traces'))).toBe(false);
  });

  test('case: empty page — no observations yields no traces and a single request', async () => {
    const fetch = vi.fn(async () => jsonResponse(200, { data: [], meta: {} }));

    const source = createLangfuseSource({
      baseUrlEnv: BASE_URL_ENV,
      publicKeyEnv: PUBLIC_KEY_ENV,
      secretKeyEnv: SECRET_KEY_ENV,
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    const traces = await collect(source.doRead({}));

    expect(traces).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('case: a trace whose observations straddle two pages is yielded once with both', async () => {
    const fetch = vi.fn(async (url: string) => {
      if (!url.includes('cursor=')) {
        return jsonResponse(200, {
          data: [
            {
              id: 'obs-1',
              traceId: 'trace-x',
              type: 'GENERATION',
              input: 'q1',
              output: 'a1',
              startTime: '2026-01-01T00:00:00.000Z',
            },
          ],
          meta: { cursor: 'C2' },
        });
      }
      return jsonResponse(200, {
        data: [
          {
            id: 'obs-2',
            traceId: 'trace-x',
            type: 'GENERATION',
            input: 'q2',
            output: 'a2',
            startTime: '2026-01-01T00:01:00.000Z',
          },
        ],
        meta: {},
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
    expect(traces[0]?.messages).toHaveLength(4);
  });

  test('case: v2 returns input as a raw JSON string — a chat-turn array is still split into turns', async () => {
    const fetch = vi.fn(async () =>
      jsonResponse(200, {
        data: [
          {
            id: 'obs-1',
            traceId: 'trace-chat',
            type: 'GENERATION',
            input: JSON.stringify([
              { role: 'system', content: 'be brief' },
              { role: 'user', content: 'hi' },
            ]),
            output: 'hello',
            startTime: '2026-01-01T00:00:00.000Z',
          },
        ],
        meta: {},
      }),
    );

    const source = createLangfuseSource({
      baseUrlEnv: BASE_URL_ENV,
      publicKeyEnv: PUBLIC_KEY_ENV,
      secretKeyEnv: SECRET_KEY_ENV,
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    const traces = await collect(source.doRead({}));

    expect(traces[0]?.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant']);
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
    const fetch = vi.fn(async () =>
      jsonResponse(200, {
        data: [
          {
            id: 'span-1',
            traceId: 'trace-empty',
            type: 'SPAN',
            input: 'x',
            output: 'y',
            startTime: '2026-01-01T00:00:00.000Z',
          },
        ],
        meta: {},
      }),
    );

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
