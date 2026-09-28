// Cascade, token and message-ordering tests (bead mol-pij.2). Two ~20-line fake dialects stand
// in for the real gen_ai/openinference/etc modules (owned by pij.11), which do not exist yet.

import { describe, expect, test, vi } from 'vitest';
import type { AnyValue, OtlpResource, OtlpResourceSpans, OtlpSpan } from '../reader/index.ts';
import { buildSpanTree } from '../reader/tree.ts';
import type { DialectV1 } from './dialect.ts';
import { detectDialect, groupByTraceId, normalizeTrace } from './index.ts';

const TRACE = '5b8efff798038103d269b633813fc60c';
const MS = 1_000_000n;

function span(
  spanId: string,
  parentSpanId: string | undefined,
  startMs: number,
  attributes: Record<string, AnyValue> = {},
): OtlpSpan {
  const start = BigInt(startMs) * MS + 1_700_000_000_000_000_000n;
  return {
    traceId: TRACE,
    spanId,
    ...(parentSpanId === undefined ? {} : { parentSpanId }),
    name: spanId,
    kind: 1,
    startTimeUnixNano: start.toString(),
    endTimeUnixNano: (start + 1000n * MS).toString(),
    attributes,
    events: [],
    links: [],
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    status: { code: 0 },
    idEncoding: 'hex',
  };
}

function resource(schemaUrl?: string): OtlpResource {
  return schemaUrl === undefined ? { attributes: {} } : { attributes: {}, schemaUrl };
}

// Matches spans tagged fake.dialect: 'a'; treats fake.llm: true spans as LLM spans, reading a
// fake.text attribute for messages and fake.input/fake.output for usage.
const dialectA: DialectV1 = {
  name: 'gen_ai',
  specCommit: 'fake-a-commit',
  detect: (s) => s.attributes['fake.dialect'] === 'a',
  isLlmSpan: (s) => s.attributes['fake.llm'] === true,
  extractMessages: (s) => {
    const text = s.attributes['fake.text'];
    return [
      { role: 'user', parts: [{ type: 'text', content: typeof text === 'string' ? text : '' }] },
    ];
  },
  extractUsage: (s) => {
    const input = s.attributes['fake.input'];
    const output = s.attributes['fake.output'];
    if (typeof input !== 'number' && typeof output !== 'number') return null;
    return {
      ...(typeof input === 'number' ? { inputTokens: input } : {}),
      ...(typeof output === 'number' ? { outputTokens: output } : {}),
    };
  },
  contentState: () => 'captured',
};

// Matches spans tagged fake.dialect: 'b'; never an LLM span.
const dialectB: DialectV1 = {
  name: 'openinference',
  detect: (s) => s.attributes['fake.dialect'] === 'b',
  isLlmSpan: () => false,
  extractMessages: () => [],
  extractUsage: () => null,
  contentState: () => 'not_captured',
};

describe('detectDialect', () => {
  test('single match', () => {
    const tree = buildSpanTree([span('a', undefined, 0, { 'fake.dialect': 'a' })]);
    const winner = detectDialect(tree, resource(), [dialectA, dialectB]);
    expect(winner?.name).toBe('gen_ai');
  });

  test('mixed match: warning + first wins', () => {
    const tree = buildSpanTree([
      span('a', undefined, 0, { 'fake.dialect': 'a' }),
      span('b', undefined, 10, { 'fake.dialect': 'b' }),
    ]);
    const onDiag = vi.fn();

    const winner = detectDialect(tree, resource(), [dialectA, dialectB], onDiag, 'trace-x');

    expect(winner?.name).toBe('gen_ai');
    expect(onDiag).toHaveBeenCalledWith({
      code: 'mixed_dialects',
      level: 'warn',
      traceId: 'trace-x',
    });
  });
});

describe('normalizeTrace', () => {
  test('no match: dialect unknown, contentCaptured false', () => {
    const tree = buildSpanTree([span('a', undefined, 0, { 'fake.dialect': 'z' })]);
    const trace = normalizeTrace(tree, resource(), [dialectA, dialectB]);

    expect(trace.dialect).toBe('unknown');
    expect(trace.dialectVersion).toBe('unknown');
    expect(trace.completeness.contentCaptured).toBe(false);
  });

  test('tokens counted once, not propagated to nested LLM span', () => {
    const tree = buildSpanTree([
      span('parent', undefined, 0, {
        'fake.dialect': 'a',
        'fake.llm': true,
        'fake.input': 10,
        'fake.output': 5,
      }),
      span('child', 'parent', 10, {
        'fake.dialect': 'a',
        'fake.llm': true,
        'fake.input': 3,
        'fake.output': 2,
      }),
    ]);
    const trace = normalizeTrace(tree, resource(), [dialectA]);

    expect(trace.tokens).toEqual({ input: 13, output: 7, total: 20 });
  });

  test('no LLM spans: tokens omitted', () => {
    const tree = buildSpanTree([span('a', undefined, 0, { 'fake.dialect': 'a' })]);
    const trace = normalizeTrace(tree, resource(), [dialectA]);

    expect(trace.tokens).toBeUndefined();
  });

  test('messageRange spans in causal order', () => {
    const tree = buildSpanTree([
      span('root', undefined, 0, {
        'fake.dialect': 'a',
        'fake.llm': true,
        'fake.text': 'root-msg',
      }),
      span('child', 'root', 10, {
        'fake.dialect': 'a',
        'fake.llm': true,
        'fake.text': 'child-msg',
      }),
    ]);
    const trace = normalizeTrace(tree, resource(), [dialectA]);

    expect(trace.messages).toHaveLength(2);
    expect(trace.spans).toEqual([
      { spanId: 'root', name: 'root', kind: 'llm', messageRange: [0, 1] },
      { spanId: 'child', name: 'child', kind: 'llm', messageRange: [1, 2] },
    ]);
  });
});

describe('groupByTraceId', () => {
  test("two resources for one traceId: first resource's schemaUrl kept", () => {
    const rs1: OtlpResourceSpans = {
      resource: resource('https://first.example/schema'),
      scopeSpans: [{ spans: [span('a', undefined, 0)] }],
    };
    const rs2: OtlpResourceSpans = {
      resource: resource('https://second.example/schema'),
      scopeSpans: [{ spans: [span('b', undefined, 10)] }],
    };

    const groups = groupByTraceId([rs1, rs2]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.resource.schemaUrl).toBe('https://first.example/schema');
    expect(groups[0]?.spans.map((s) => s.spanId)).toEqual(['a', 'b']);
  });
});
