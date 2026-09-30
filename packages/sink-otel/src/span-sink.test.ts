import { safeParseJson, type Verdict } from '@vetkit/spec';
import { describe, expect, test } from 'vitest';
import { createOpenInferenceSink } from './span-sink.ts';

const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const SPAN_ID = 'b7ad6b7169203331';
const ENDPOINT = 'http://phoenix:6006';

interface OtlpAttribute {
  key: string;
  value: { stringValue?: string; doubleValue?: number; boolValue?: boolean };
}

interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  links: Array<{ traceId: string; spanId: string }>;
  attributes: OtlpAttribute[];
}

interface OtlpBody {
  resourceSpans: Array<{ scopeSpans: Array<{ spans: OtlpSpan[] }> }>;
}

interface Captured {
  url: string;
  init: RequestInit;
  body: OtlpBody;
}

function fakeFetch(respond: () => Response = () => new Response('{}')): {
  fetch: typeof fetch;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const impl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const text = typeof init?.body === 'string' ? init.body : '';
    const parsed = safeParseJson<OtlpBody>(text, { type: 'object' });
    if (!parsed.ok) throw parsed.error;
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init: init ?? {}, body: parsed.value });
    return Promise.resolve(respond());
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

function spans(call: Captured | undefined): OtlpSpan[] {
  return call?.body.resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans)) ?? [];
}

function attr(span: OtlpSpan | undefined, key: string): OtlpAttribute['value'] | undefined {
  return span?.attributes.find((a) => a.key === key)?.value;
}

const EV = 'evaluations.0.evaluation';

function expectCarrier(span: OtlpSpan | undefined): void {
  expect(attr(span, 'openinference.span.kind')).toEqual({ stringValue: 'EVALUATOR' });
  expect(span?.links).toEqual([{ traceId: TRACE_ID, spanId: SPAN_ID }]);
  expect(span?.parentSpanId).toBeUndefined();
  expect(span?.traceId).toMatch(/^[0-9a-f]{32}$/);
  expect(span?.spanId).toMatch(/^[0-9a-f]{16}$/);
  expect(span?.traceId).not.toBe(TRACE_ID);
  expect(span?.name).toBe('vet.evaluate');
  expect(span?.kind).toBe(1);
  expect(span?.startTimeUnixNano).toBe(span?.endTimeUnixNano);
  expect(attr(span, `${EV}.name`)).toEqual({ stringValue: 'promised_refund' });
  expect(attr(span, `${EV}.annotator_kind`)).toEqual({ stringValue: 'LLM' });
  expect(attr(span, `${EV}.identifier`)).toEqual({ stringValue: 'v-1' });
}

describe('createOpenInferenceSink', () => {
  test('boolean: one EVALUATOR carrier span linked to the verdict provenance', async () => {
    const { fetch, calls } = fakeFetch();
    const sink = createOpenInferenceSink({ endpoint: ENDPOINT, fetch });
    const ack = await sink.doWrite([verdict()], {});

    expect(sink.id).toBe('otel/openinference');
    expect(sink.capabilities).toEqual({ batch: 200, idempotent: false });
    expect(ack).toEqual({ accepted: ['v-1'], rejected: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://phoenix:6006/v1/traces');
    expect(calls[0]?.init.method).toBe('POST');
    expect(new Headers(calls[0]?.init.headers).get('content-type')).toBe('application/json');
    const all = spans(calls[0]);
    expect(all).toHaveLength(1);
    const span = all[0];
    expectCarrier(span);
    expect(attr(span, `${EV}.score`)).toEqual({ doubleValue: 0.98 });
    expect(attr(span, `${EV}.label`)).toEqual({ stringValue: 'pass' });
    expect(attr(span, `${EV}.explanation`)).toEqual({
      stringValue: 'promised_refund: p=0.98 >= threshold 0.70 → pass',
    });
  });

  test('score: score is the expected level, label the legend name', async () => {
    const { fetch, calls } = fakeFetch();
    const sink = createOpenInferenceSink({ endpoint: ENDPOINT, fetch });
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
    const span = spans(calls[0])[0];
    expectCarrier(span);
    expect(attr(span, `${EV}.score`)).toEqual({ doubleValue: 1.8 });
    expect(attr(span, `${EV}.label`)).toEqual({ stringValue: 'good' });
    expect(attr(span, `${EV}.explanation`)?.stringValue).toContain('promised_refund: score=1.80');
  });

  test("unscored: label 'unscored', explanation is the cause, no score attribute", async () => {
    const { fetch, calls } = fakeFetch();
    const sink = createOpenInferenceSink({ endpoint: ENDPOINT, fetch });
    const unscored = verdict({ status: 'unscored', cause: 'judge returned no answer' });
    delete unscored.answer;
    delete unscored.pass;
    const ack = await sink.doWrite([unscored], {});
    expect(ack.accepted).toEqual(['v-1']);
    const span = spans(calls[0])[0];
    expectCarrier(span);
    expect(attr(span, `${EV}.label`)).toEqual({ stringValue: 'unscored' });
    expect(attr(span, `${EV}.explanation`)).toEqual({ stringValue: 'judge returned no answer' });
    expect(attr(span, `${EV}.score`)).toBeUndefined();
  });

  test('two verdicts: two carrier spans for the same target, each with one link', async () => {
    const { fetch, calls } = fakeFetch();
    const sink = createOpenInferenceSink({ endpoint: ENDPOINT, fetch });
    const ack = await sink.doWrite([verdict(), verdict({ id: 'v-2' })], {});
    expect(ack.accepted).toEqual(['v-1', 'v-2']);
    const [a, b] = spans(calls[0]);
    for (const span of [a, b]) {
      expect(span?.links).toEqual([{ traceId: TRACE_ID, spanId: SPAN_ID }]);
      expect(span?.parentSpanId).toBeUndefined();
    }
    expect(a?.spanId).not.toBe(b?.spanId);
    expect(attr(b, `${EV}.identifier`)).toEqual({ stringValue: 'v-2' });
  });

  test("a verdict missing traceId or spanId is rejected 'no correlation id', not sent", async () => {
    const { fetch, calls } = fakeFetch();
    const sink = createOpenInferenceSink({ endpoint: ENDPOINT, fetch });
    const ack = await sink.doWrite(
      [
        verdict({ id: 'a', provenance: { traceId: TRACE_ID } }),
        verdict({ id: 'b', provenance: { responseId: 'resp-1' } }),
      ],
      {},
    );
    expect(ack).toEqual({
      accepted: [],
      rejected: [
        { id: 'a', reason: 'no correlation id', retryable: false },
        { id: 'b', reason: 'no correlation id', retryable: false },
      ],
    });
    expect(calls).toHaveLength(0);
  });

  test('a non-hex span id is rejected as invalid correlation id', async () => {
    const { fetch, calls } = fakeFetch();
    const sink = createOpenInferenceSink({ endpoint: ENDPOINT, fetch });
    const ack = await sink.doWrite(
      [verdict({ provenance: { traceId: TRACE_ID, spanId: 'zz' } })],
      {},
    );
    expect(ack.rejected).toEqual([
      { id: 'v-1', reason: 'invalid correlation id', retryable: false },
    ]);
    expect(calls).toHaveLength(0);
  });

  test('HTTP 503 rejects every item retryable; 401 rejects SINK_AUTH', async () => {
    const down = createOpenInferenceSink({
      endpoint: ENDPOINT,
      fetch: fakeFetch(() => new Response('', { status: 503 })).fetch,
    });
    expect((await down.doWrite([verdict()], {})).rejected).toEqual([
      { id: 'v-1', reason: 'SINK_UNREACHABLE:503', retryable: true },
    ]);
    const denied = createOpenInferenceSink({
      endpoint: ENDPOINT,
      fetch: fakeFetch(() => new Response('', { status: 401 })).fetch,
    });
    expect((await denied.doWrite([verdict()], {})).rejected).toEqual([
      { id: 'v-1', reason: 'SINK_AUTH', retryable: false },
    ]);
  });

  test('capabilities.idempotent is false: a resend mints a new carrier span', async () => {
    const { fetch, calls } = fakeFetch();
    const sink = createOpenInferenceSink({ endpoint: ENDPOINT, fetch });
    expect(sink.capabilities.idempotent).toBe(false);

    await sink.doWrite([verdict()], {});
    await sink.doWrite([verdict()], {});
    const [first, second] = calls;
    const firstSpan = spans(first)[0];
    const secondSpan = spans(second)[0];
    expect(firstSpan?.spanId).not.toBe(secondSpan?.spanId);
    expect(firstSpan?.traceId).not.toBe(secondSpan?.traceId);
  });

  test('a body over 4 MiB is split before sending', async () => {
    const { fetch, calls } = fakeFetch();
    const sink = createOpenInferenceSink({ endpoint: ENDPOINT, fetch });
    const big = 'x'.repeat(1024 * 1024);
    const ack = await sink.doWrite(
      [verdict({ criterionId: big }), verdict({ id: 'v-2', criterionId: big })],
      {},
    );
    expect(calls).toHaveLength(2);
    expect(ack.accepted).toEqual(['v-1', 'v-2']);
    for (const call of calls) expect(spans(call)).toHaveLength(1);
  });
});

async function spanFor(v: Verdict): Promise<OtlpSpan | undefined> {
  const { fetch, calls } = fakeFetch();
  await createOpenInferenceSink({ endpoint: ENDPOINT, fetch }).doWrite([v], {});
  return spans(calls[0])[0];
}

describe('annotator_kind', () => {
  const codeModel = { requested: 'r', resolved: 'r', transport: 'code', pinned: true };

  test('a judge transport yields LLM', async () => {
    const span = await spanFor(verdict());
    expect(attr(span, `${EV}.annotator_kind`)).toEqual({ stringValue: 'LLM' });
  });

  test("transport 'code' yields CODE", async () => {
    const span = await spanFor(verdict({ model: codeModel }));
    expect(attr(span, `${EV}.annotator_kind`)).toEqual({ stringValue: 'CODE' });
  });

  test("transport 'demo' yields CODE", async () => {
    const span = await spanFor(verdict({ model: { ...codeModel, transport: 'demo' } }));
    expect(attr(span, `${EV}.annotator_kind`)).toEqual({ stringValue: 'CODE' });
  });

  test('an unscored verdict still carries annotator_kind', async () => {
    const span = await spanFor(
      verdict({
        status: 'unscored',
        answer: undefined,
        pass: undefined,
        cause: 'x',
        model: codeModel,
      }),
    );
    expect(attr(span, `${EV}.annotator_kind`)).toEqual({ stringValue: 'CODE' });
    const llm = await spanFor(verdict({ status: 'unscored', answer: undefined, pass: undefined }));
    expect(attr(llm, `${EV}.annotator_kind`)).toEqual({ stringValue: 'LLM' });
  });

  test('no span attribute value equals the retired constant', async () => {
    const retired = ['J', 'E', 'V'].join('');
    const span = await spanFor(verdict());
    expect(span?.attributes.map((a) => a.value.stringValue)).not.toContain(retired);
  });

  test('the vetkit.model.transport attribute carries the transport string', async () => {
    const span = await spanFor(verdict());
    expect(attr(span, 'vetkit.model.transport')).toEqual({ stringValue: 'test' });
    expect(attr(span, 'vetkit.model.resolved')).toEqual({ stringValue: 'judge-2026' });
    expect(attr(span, 'vetkit.model.pinned')).toEqual({ boolValue: false });
  });

  test('no span attribute key uses the old namespace', async () => {
    const span = await spanFor(verdict());
    expect(span?.attributes.filter((a) => a.key.startsWith('classified_evals.'))).toEqual([]);
  });
});
