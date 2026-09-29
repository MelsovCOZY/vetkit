import { safeParseJson } from '@vetkit/spec';
import type { Verdict } from '@vetkit/spec';
import { describe, expect, it } from 'vitest';
import { createLangfuseSink } from './sink.ts';

const PK = 'pk-lf-test-public';
const SK = 'sk-lf-test-secret';

interface Call {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

function fakeFetch(respond: (call: Call, index: number) => Response | Promise<Response>): {
  fetch: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const raw = typeof init?.body === 'string' ? init.body : '{}';
    const parsed = safeParseJson<Record<string, unknown>>(raw, { type: 'object' });
    if (!parsed.ok) throw parsed.error;
    const body = parsed.value;
    const call: Call = {
      url: input instanceof Request ? input.url : input.toString(),
      init: init ?? {},
      body,
    };
    calls.push(call);
    return respond(call, calls.length - 1);
  };
  return { fetch: impl, calls };
}

const ok = (): Response =>
  new Response(JSON.stringify({ id: 'score-1' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

function verdict(over: Partial<Verdict> = {}): Verdict {
  return {
    id: 'v-1',
    caseId: 'case-1',
    criterionId: 'grounded',
    status: 'ok',
    answer: { type: 'boolean', probability: 0.91 },
    threshold: 0.7,
    pass: true,
    model: { requested: 'jev', resolved: 'jev-1.13.0', transport: 'fake', pinned: false },
    cacheHit: false,
    explanation: 'grounded: p=0.91 >= threshold 0.70 → pass',
    provenance: { traceId: 'trace-abc', observationId: 'obs-123' },
    ...over,
  };
}

function sink(f: typeof fetch, baseUrl = 'https://lf.example.test') {
  return createLangfuseSink({ baseUrl, publicKey: PK, secretKey: SK, fetch: f });
}

async function idOf(v: Verdict): Promise<unknown> {
  const { fetch, calls } = fakeFetch(ok);
  await sink(fetch).doWrite([v], {});
  return calls[0]?.body['id'];
}

describe('createLangfuseSink doWrite', () => {
  it('boolean: posts BOOLEAN 1|0 per threshold with basic auth and observationId', async () => {
    const { fetch, calls } = fakeFetch(ok);
    const ack = await sink(fetch, 'https://lf.example.test/').doWrite(
      [
        verdict(),
        verdict({ id: 'v-2', answer: { type: 'boolean', probability: 0.4 }, pass: false }),
      ],
      {},
    );
    expect(ack).toEqual({ accepted: ['v-1', 'v-2'], rejected: [] });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe('https://lf.example.test/api/public/scores');
    expect(calls[0]?.init.method).toBe('POST');
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get('authorization')).toBe(
      `Basic ${Buffer.from(`${PK}:${SK}`).toString('base64')}`,
    );
    expect(headers.get('content-type')).toBe('application/json');
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]?.body).toEqual({
      id: expect.any(String),
      traceId: 'trace-abc',
      observationId: 'obs-123',
      name: 'grounded',
      value: 1,
      dataType: 'BOOLEAN',
      comment: 'grounded: p=0.91 >= threshold 0.70 → pass',
    });
    expect(calls[1]?.body['value']).toBe(0);
  });

  it('choice: posts CATEGORICAL with the chosen option as the string value', async () => {
    const { fetch, calls } = fakeFetch(ok);
    const ack = await sink(fetch).doWrite(
      [
        verdict({
          criterionId: 'tone',
          answer: {
            type: 'choice',
            choice: 'polite',
            confidence: 0.8,
            probabilities: { polite: 0.8, rude: 0.2 },
          },
        }),
      ],
      {},
    );
    expect(ack.accepted).toEqual(['v-1']);
    expect(calls[0]?.body).toMatchObject({
      traceId: 'trace-abc',
      observationId: 'obs-123',
      name: 'tone',
      value: 'polite',
      dataType: 'CATEGORICAL',
    });
  });

  it('score: posts NUMERIC with the expected level', async () => {
    const { fetch, calls } = fakeFetch(ok);
    await sink(fetch).doWrite(
      [
        verdict({
          criterionId: 'helpfulness',
          answer: {
            type: 'score',
            score: 2,
            confidence: 0.6,
            legend: { '0': 'bad', '1': 'ok', '2': 'good' },
            probabilities: { '0': 0.1, '1': 0.3, '2': 0.6 },
          },
        }),
      ],
      {},
    );
    expect(calls[0]?.body['dataType']).toBe('NUMERIC');
    expect(calls[0]?.body['name']).toBe('helpfulness');
    expect(calls[0]?.body['value']).toBeCloseTo(1.5, 10);
  });

  it('missing observationId: posts a traceId-only body', async () => {
    const { fetch, calls } = fakeFetch(ok);
    const ack = await sink(fetch).doWrite([verdict({ provenance: { traceId: 'trace-abc' } })], {});
    expect(ack.accepted).toEqual(['v-1']);
    expect(calls[0]?.body['traceId']).toBe('trace-abc');
    expect(calls[0]?.body).not.toHaveProperty('observationId');
  });

  it('unscored: a verdict with status != ok is not posted and is reported skipped, not rejected', async () => {
    const { fetch, calls } = fakeFetch(ok);
    const ack = await sink(fetch).doWrite(
      [verdict({ id: 'v-bad', status: 'infra_failure' }), verdict()],
      {},
    );
    expect(calls).toHaveLength(1);
    expect(ack.accepted).toEqual(['v-1']);
    expect(ack.rejected).toEqual([]);
    expect(ack.skipped).toEqual([{ id: 'v-bad', reason: 'unscored:infra_failure' }]);
  });

  it('no correlation id: a verdict without traceId is not posted', async () => {
    const { fetch, calls } = fakeFetch(ok);
    const ack = await sink(fetch).doWrite([verdict({ provenance: { responseId: 'r-1' } })], {});
    expect(calls).toHaveLength(0);
    expect(ack.rejected).toEqual([{ id: 'v-1', reason: 'no correlation id', retryable: false }]);
  });

  it('auth: 401 rejects SINK_AUTH non-retryable without leaking credentials', async () => {
    const { fetch } = fakeFetch(() => new Response('{"message":"bad key sk-lf"}', { status: 401 }));
    const ack = await sink(fetch).doWrite([verdict()], {});
    expect(ack.accepted).toEqual([]);
    expect(ack.rejected).toHaveLength(1);
    const [rej] = ack.rejected;
    expect(rej?.id).toBe('v-1');
    expect(rej?.retryable).toBe(false);
    expect(rej?.reason).toMatch(/^SINK_AUTH/);
    expect(rej?.reason).not.toContain(SK);
    expect(rej?.reason).not.toContain(PK);
    expect(rej?.reason).not.toContain(Buffer.from(`${PK}:${SK}`).toString('base64'));
    expect(rej?.reason).not.toContain('bad key');
  });

  it('retryable: 429 and 5xx and network errors reject retryable=true', async () => {
    const statuses = [429, 500, 503];
    const { fetch } = fakeFetch((_call, i) => {
      const status = statuses[i];
      if (status === undefined) throw new TypeError(`fetch failed ${SK}`);
      return new Response('nope', { status });
    });
    const ack = await sink(fetch).doWrite(
      [verdict({ id: 'a' }), verdict({ id: 'b' }), verdict({ id: 'c' }), verdict({ id: 'd' })],
      {},
    );
    expect(ack.accepted).toEqual([]);
    expect(ack.rejected.map((r) => [r.id, r.retryable])).toEqual([
      ['a', true],
      ['b', true],
      ['c', true],
      ['d', true],
    ]);
    for (const r of ack.rejected) expect(r.reason).not.toContain(SK);
  });

  it('a non-auth 4xx rejects non-retryable', async () => {
    const { fetch } = fakeFetch(() => new Response('bad', { status: 400 }));
    const ack = await sink(fetch).doWrite([verdict()], {});
    expect(ack.rejected[0]?.retryable).toBe(false);
    expect(ack.rejected[0]?.reason).toMatch(/^SINK_REJECTED/);
  });

  it('capabilities: id langfuse/scores, batch 50, idempotent false', () => {
    const s = sink(fakeFetch(ok).fetch);
    expect(s.specVersion).toBe('v1');
    expect(s.id).toBe('langfuse/scores');
    expect(s.capabilities).toEqual({ batch: 50, idempotent: false });
  });

  describe('deterministic score id', () => {
    it('the same verdict under a different verdict id yields the same score id', async () => {
      const a = await idOf(verdict({ id: 'run-1' }));
      const b = await idOf(verdict({ id: 'run-2' }));
      expect(typeof a).toBe('string');
      expect(a).toBe(b);
    });

    it('differs by criterion, case and observation', async () => {
      const base = await idOf(verdict());
      expect(await idOf(verdict({ criterionId: 'other' }))).not.toBe(base);
      expect(await idOf(verdict({ caseId: 'case-2' }))).not.toBe(base);
      expect(await idOf(verdict({ provenance: { traceId: 'trace-abc' } }))).not.toBe(base);
    });
  });
});
