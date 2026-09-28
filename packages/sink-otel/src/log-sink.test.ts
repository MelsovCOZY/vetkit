import { safeParseJson, type Verdict } from '@vetkit/spec';
import { describe, expect, test } from 'vitest';
import { createOtelSink } from './log-sink.ts';

const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const SPAN_ID = 'b7ad6b7169203331';

interface Captured {
  url: string;
  init: RequestInit;
  body: OtlpBody;
}

interface OtlpAttribute {
  key: string;
  value: { stringValue?: string; doubleValue?: number; boolValue?: boolean };
}

interface OtlpLogRecord {
  traceId?: string;
  spanId?: string;
  eventName?: string;
  attributes: OtlpAttribute[];
}

interface OtlpBody {
  resourceLogs: Array<{
    scopeLogs: Array<{ schemaUrl?: string; logRecords: OtlpLogRecord[] }>;
  }>;
}

function fakeFetch(
  respond: (call: number) => Response | Promise<Response> = () => new Response('{}'),
): { fetch: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const impl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const text = typeof init?.body === 'string' ? init.body : '';
    const parsed = safeParseJson<OtlpBody>(text, { type: 'object' });
    if (!parsed.ok) throw parsed.error;
    const body = parsed.value;
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init: init ?? {}, body });
    return Promise.resolve(respond(calls.length));
  };
  return { fetch: impl, calls };
}

function verdict(overrides: Partial<Verdict> = {}): Verdict {
  return {
    id: 'v-1',
    caseId: 'case-1',
    criterionId: 'promised_refund',
    status: 'ok',
    answer: { type: 'boolean', probability: 0.98 },
    pass: true,
    threshold: 0.7,
    model: { requested: 'judge', resolved: 'judge-2026', transport: 'test', pinned: false },
    cacheHit: false,
    provenance: { traceId: TRACE_ID, spanId: SPAN_ID },
    ...overrides,
  };
}

function without(v: Verdict, key: 'answer' | 'provenance'): Verdict {
  const copy = { ...v };
  delete copy[key];
  return copy;
}

function byString(a: string | undefined, b: string | undefined): number {
  return (a ?? '').localeCompare(b ?? '');
}

const throwingFetch: typeof fetch = () => Promise.reject(new TypeError('getaddrinfo'));

function records(call: Captured | undefined): OtlpLogRecord[] {
  return call?.body.resourceLogs.flatMap((r) => r.scopeLogs.flatMap((s) => s.logRecords)) ?? [];
}

function attr(record: OtlpLogRecord | undefined, key: string): OtlpAttribute['value'] | undefined {
  return record?.attributes.find((a) => a.key === key)?.value;
}

describe('createOtelSink', () => {
  test('boolean: one logRecord on the provenance trace/span with evaluation attributes', async () => {
    const { fetch, calls } = fakeFetch();
    const sink = createOtelSink({ endpoint: 'http://collector:4318', fetch });
    const ack = await sink.doWrite([verdict()], {});

    expect(sink.id).toBe('otel/logs');
    expect(sink.capabilities).toEqual({ batch: 200, idempotent: true });
    expect(ack).toEqual({ accepted: ['v-1'], rejected: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://collector:4318/v1/logs');
    expect(new Headers(calls[0]?.init.headers).get('content-type')).toBe('application/json');
    expect(calls[0]?.init.method).toBe('POST');
    const recs = records(calls[0]);
    expect(recs).toHaveLength(1);
    const rec = recs[0];
    expect(rec?.traceId).toBe(TRACE_ID);
    expect(rec?.spanId).toBe(SPAN_ID);
    expect(rec?.eventName).toBe('gen_ai.evaluation.result');
    expect(attr(rec, 'gen_ai.evaluation.name')).toEqual({ stringValue: 'promised_refund' });
    expect(attr(rec, 'gen_ai.evaluation.score.value')).toEqual({ doubleValue: 0.98 });
    expect(attr(rec, 'gen_ai.evaluation.score.label')).toEqual({ stringValue: 'pass' });
    expect(attr(rec, 'gen_ai.evaluation.explanation')).toEqual({
      stringValue: 'promised_refund: p=0.98 >= threshold 0.70 → pass',
    });
    expect(attr(rec, 'classified_evals.model.resolved')).toEqual({ stringValue: 'judge-2026' });
    expect(attr(rec, 'error.type')).toBeUndefined();
    expect(calls[0]?.body.resourceLogs[0]?.scopeLogs[0]?.schemaUrl).toMatch(/^https:\/\//);
  });

  test('choice: label is the chosen option, value is its credit (1 when passing)', async () => {
    const { fetch, calls } = fakeFetch();
    const sink = createOtelSink({ endpoint: 'http://collector:4318', fetch });
    await sink.doWrite(
      [
        verdict({
          answer: {
            type: 'choice',
            choice: 'refund',
            confidence: 0.9,
            probabilities: { refund: 0.9, deny: 0.1 },
          },
          pass: true,
        }),
        verdict({
          id: 'v-2',
          answer: {
            type: 'choice',
            choice: 'deny',
            confidence: 0.8,
            probabilities: { refund: 0.2, deny: 0.8 },
          },
          pass: false,
        }),
      ],
      {},
    );
    const [first, second] = records(calls[0]);
    expect(attr(first, 'gen_ai.evaluation.score.label')).toEqual({ stringValue: 'refund' });
    expect(attr(first, 'gen_ai.evaluation.score.value')).toEqual({ doubleValue: 1 });
    expect(attr(second, 'gen_ai.evaluation.score.label')).toEqual({ stringValue: 'deny' });
    expect(attr(second, 'gen_ai.evaluation.score.value')).toEqual({ doubleValue: 0 });
  });

  test('score: value is the expected level index, label the legend name', async () => {
    const { fetch, calls } = fakeFetch();
    const sink = createOtelSink({ endpoint: 'http://collector:4318', fetch });
    await sink.doWrite(
      [
        verdict({
          answer: {
            type: 'score',
            score: 1.8,
            confidence: 0.7,
            legend: { '0': 'poor', '1': 'fair', '2': 'good' },
            probabilities: { '0': 0.05, '1': 0.1, '2': 0.85 },
          },
        }),
      ],
      {},
    );
    const rec = records(calls[0])[0];
    expect(attr(rec, 'gen_ai.evaluation.score.value')).toEqual({ doubleValue: 1.8 });
    expect(attr(rec, 'gen_ai.evaluation.score.label')).toEqual({ stringValue: 'good' });
  });

  test('unscored: error.type is the status and no score attributes are emitted', async () => {
    const { fetch, calls } = fakeFetch();
    const sink = createOtelSink({ endpoint: 'http://collector:4318', fetch });
    const ack = await sink.doWrite([without(verdict({ status: 'unscored' }), 'answer')], {});
    expect(ack.accepted).toEqual(['v-1']);
    const rec = records(calls[0])[0];
    expect(attr(rec, 'error.type')).toEqual({ stringValue: 'unscored' });
    expect(attr(rec, 'gen_ai.evaluation.name')).toEqual({ stringValue: 'promised_refund' });
    expect(attr(rec, 'gen_ai.evaluation.score.value')).toBeUndefined();
    expect(attr(rec, 'gen_ai.evaluation.score.label')).toBeUndefined();
  });

  test('uncorrelated: no traceId and no responseId is rejected and nothing is sent', async () => {
    const { fetch, calls } = fakeFetch();
    const sink = createOtelSink({ endpoint: 'http://collector:4318', fetch });
    const ack = await sink.doWrite([verdict({ provenance: { spanId: SPAN_ID } })], {});
    expect(ack).toEqual({
      accepted: [],
      rejected: [{ id: 'v-1', reason: 'no correlation id', retryable: false }],
    });
    expect(calls).toHaveLength(0);
  });

  test('uncorrelated item is rejected while its correlated batch-mate is still sent', async () => {
    const { fetch, calls } = fakeFetch();
    const sink = createOtelSink({ endpoint: 'http://collector:4318', fetch });
    const ack = await sink.doWrite([without(verdict({ id: 'lost' }), 'provenance'), verdict()], {});
    expect(ack.accepted).toEqual(['v-1']);
    expect(ack.rejected).toEqual([{ id: 'lost', reason: 'no correlation id', retryable: false }]);
    expect(records(calls[0])).toHaveLength(1);
  });

  test('responseId-only verdict is sent with gen_ai.response.id and no span context', async () => {
    const { fetch, calls } = fakeFetch();
    const sink = createOtelSink({ endpoint: 'http://collector:4318', fetch });
    const ack = await sink.doWrite([verdict({ provenance: { responseId: 'resp-1' } })], {});
    expect(ack.accepted).toEqual(['v-1']);
    const rec = records(calls[0])[0];
    expect(attr(rec, 'gen_ai.response.id')).toEqual({ stringValue: 'resp-1' });
    expect(rec?.traceId).toBeUndefined();
  });

  test('non-hex or wrong-length trace ids are rejected as invalid correlation id', async () => {
    const { fetch, calls } = fakeFetch();
    const sink = createOtelSink({ endpoint: 'http://collector:4318', fetch });
    const ack = await sink.doWrite(
      [
        verdict({ id: 'a', provenance: { traceId: 'xyz', spanId: SPAN_ID } }),
        verdict({ id: 'b', provenance: { traceId: TRACE_ID, spanId: 'abc' } }),
      ],
      {},
    );
    expect(ack.rejected).toEqual([
      { id: 'a', reason: 'invalid correlation id', retryable: false },
      { id: 'b', reason: 'invalid correlation id', retryable: false },
    ]);
    expect(calls).toHaveLength(0);
  });

  test.each([429, 502, 503, 504])(
    'retryable: HTTP %i rejects every item retryable with SINK_UNREACHABLE:<status>',
    async (status) => {
      const { fetch } = fakeFetch(() => new Response('', { status }));
      const sink = createOtelSink({ endpoint: 'http://collector:4318', fetch });
      const ack = await sink.doWrite([verdict(), verdict({ id: 'v-2' })], {});
      expect(ack).toEqual({
        accepted: [],
        rejected: [
          { id: 'v-1', reason: `SINK_UNREACHABLE:${status}`, retryable: true },
          { id: 'v-2', reason: `SINK_UNREACHABLE:${status}`, retryable: true },
        ],
      });
    },
  );

  test.each([401, 403])('auth: HTTP %i rejects every item SINK_AUTH, not retryable', async (s) => {
    const { fetch } = fakeFetch(() => new Response('', { status: s }));
    const sink = createOtelSink({ endpoint: 'http://collector:4318', fetch });
    const ack = await sink.doWrite([verdict()], {});
    expect(ack).toEqual({
      accepted: [],
      rejected: [{ id: 'v-1', reason: 'SINK_AUTH', retryable: false }],
    });
  });

  test('partial: 200 with partialSuccess.rejectedLogRecords rejects that many retryable', async () => {
    const { fetch } = fakeFetch(
      () => new Response(JSON.stringify({ partialSuccess: { rejectedLogRecords: '1' } })),
    );
    const sink = createOtelSink({ endpoint: 'http://collector:4318', fetch });
    const ack = await sink.doWrite([verdict(), verdict({ id: 'v-2' }), verdict({ id: 'v-3' })], {});
    expect(ack.accepted).toHaveLength(2);
    expect(ack.rejected).toHaveLength(1);
    expect(ack.rejected[0]?.retryable).toBe(true);
    expect([...ack.accepted, ack.rejected[0]?.id].toSorted(byString)).toEqual([
      'v-1',
      'v-2',
      'v-3',
    ]);
  });

  test('fetch throwing maps to SINK_UNREACHABLE:network for every item, never throws', async () => {
    const sink = createOtelSink({ endpoint: 'http://collector:4318', fetch: throwingFetch });
    const ack = await sink.doWrite([verdict()], {});
    expect(ack.rejected).toEqual([
      { id: 'v-1', reason: 'SINK_UNREACHABLE:network', retryable: true },
    ]);
  });

  test('every POST carries an AbortSignal deadline', async () => {
    const { fetch, calls } = fakeFetch();
    const sink = createOtelSink({ endpoint: 'http://collector:4318', fetch, timeoutMs: 50 });
    await sink.doWrite([verdict()], {});
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  test('an endpoint that already has a path is used as-is; custom headers are sent', async () => {
    const { fetch, calls } = fakeFetch();
    const sink = createOtelSink({
      endpoint: 'https://otel.example.test/api/public/otel/v1/logs',
      headers: { authorization: 'Basic abc' },
      fetch,
    });
    await sink.doWrite([verdict()], {});
    expect(calls[0]?.url).toBe('https://otel.example.test/api/public/otel/v1/logs');
    expect(new Headers(calls[0]?.init.headers).get('authorization')).toBe('Basic abc');
  });

  test('a body over 4 MiB is split in halves before sending', async () => {
    const { fetch, calls } = fakeFetch();
    const sink = createOtelSink({ endpoint: 'http://collector:4318', fetch });
    const big = 'x'.repeat(1024 * 1024);
    const ack = await sink.doWrite(
      [verdict({ criterionId: big }), verdict({ id: 'v-2', criterionId: big })],
      {},
    );
    expect(calls).toHaveLength(2);
    expect(ack.accepted.toSorted(byString)).toEqual(['v-1', 'v-2']);
    for (const call of calls) expect(records(call)).toHaveLength(1);
  });
});
