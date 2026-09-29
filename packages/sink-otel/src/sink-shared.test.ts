import type { SinkAck, SinkV1, Verdict } from '@vetkit/spec';
import { describe, expect, test } from 'vitest';
import { createOtelSink } from './log-sink.ts';
import { mergeAcks, rejectAll, resolveUrl, statusToAck } from './sink-shared.ts';
import { createOpenInferenceSink } from './span-sink.ts';

function verdict(id: string): Verdict {
  return {
    id,
    caseId: 'case-1',
    criterionId: 'c',
    status: 'ok',
    answer: { type: 'boolean', probability: 0.98 },
    pass: true,
    threshold: 0.7,
    model: { requested: 'judge', resolved: 'judge-2026', transport: 'test', pinned: false },
    cacheHit: false,
    provenance: {
      traceId: '0af7651916cd43dd8448eb211c80319c',
      spanId: 'b7ad6b7169203331',
    },
  };
}

const entries = [
  { id: 'a', verdict: verdict('a') },
  { id: 'b', verdict: verdict('b') },
];

type Outcome = number | 'network';

type Row = [outcome: Outcome, reason: string | undefined, retryable: boolean];

const TABLE: Row[] = [
  [200, undefined, false],
  [201, undefined, false],
  [400, 'SINK_REJECTED:400', false],
  [404, 'SINK_REJECTED:404', false],
  [401, 'SINK_AUTH', false],
  [403, 'SINK_AUTH', false],
  [413, 'SINK_PAYLOAD_TOO_LARGE', true],
  [429, 'SINK_UNREACHABLE:429', true],
  [500, 'SINK_REJECTED:500', false],
  [502, 'SINK_UNREACHABLE:502', true],
  [503, 'SINK_UNREACHABLE:503', true],
  [504, 'SINK_UNREACHABLE:504', true],
  ['network', 'SINK_UNREACHABLE:network', true],
];

function fetchFor(outcome: Outcome): typeof fetch {
  return () =>
    outcome === 'network'
      ? Promise.reject(new TypeError('connection refused'))
      : Promise.resolve(new Response('{}', { status: outcome }));
}

type Make = (o: { endpoint: string; fetch: typeof fetch }) => SinkV1;

function ackOf(make: Make, outcome: Outcome): Promise<SinkAck> {
  const sink = make({ endpoint: 'http://collector:4318', fetch: fetchFor(outcome) });
  return sink.doWrite([verdict('v-1'), verdict('v-2')], {});
}

describe('shared helpers', () => {
  test('rejectAll marks every entry with the reason and retryable flag', () => {
    expect(rejectAll(entries, 'X', true)).toEqual({
      accepted: [],
      rejected: [
        { id: 'a', reason: 'X', retryable: true },
        { id: 'b', reason: 'X', retryable: true },
      ],
    });
  });

  test('mergeAcks concatenates accepted and rejected in order', () => {
    const a: SinkAck = { accepted: ['1'], rejected: [{ id: '2', reason: 'r', retryable: false }] };
    const b: SinkAck = { accepted: ['3'], rejected: [{ id: '4', reason: 's', retryable: true }] };
    expect(mergeAcks(a, b)).toEqual({
      accepted: ['1', '3'],
      rejected: [
        { id: '2', reason: 'r', retryable: false },
        { id: '4', reason: 's', retryable: true },
      ],
    });
  });

  test('resolveUrl defaults the path only for a bare endpoint', () => {
    expect(resolveUrl('http://h:4318', '/v1/x')).toBe('http://h:4318/v1/x');
    expect(resolveUrl('http://h:4318/custom', '/v1/x')).toBe('http://h:4318/custom');
  });

  test.each(TABLE)('statusToAck maps %s', (outcome, reason, retryable) => {
    if (outcome === 'network') return;
    const ack = statusToAck(outcome, entries);
    if (reason === undefined) expect(ack).toBeUndefined();
    else expect(ack).toEqual(rejectAll(entries, reason, retryable));
  });
});

describe('log and span sinks share one status table', () => {
  test.each(TABLE)('outcome %s yields equal acks', async (outcome, reason, retryable) => {
    const logs = await ackOf(createOtelSink, outcome);
    const spans = await ackOf(createOpenInferenceSink, outcome);
    expect(spans).toEqual(logs);
    if (reason === undefined) expect(logs).toEqual({ accepted: ['v-1', 'v-2'], rejected: [] });
    else {
      expect(logs.accepted).toEqual([]);
      expect(logs.rejected).toEqual(['v-1', 'v-2'].map((id) => ({ id, reason, retryable })));
    }
  });
});
