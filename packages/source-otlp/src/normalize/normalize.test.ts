// Cascade, token and message-ordering tests (bead mol-pij.2). Two ~20-line fake dialects stand
// in for the real gen_ai/openinference/etc modules (owned by pij.11), which do not exist yet.

import { describe, expect, test, vi } from 'vitest';
import type { Message } from '@vetkit/spec';
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
    const total = s.attributes['fake.total'];
    if (typeof input !== 'number' && typeof output !== 'number' && typeof total !== 'number') {
      return null;
    }
    return {
      ...(typeof input === 'number' ? { inputTokens: input } : {}),
      ...(typeof output === 'number' ? { outputTokens: output } : {}),
      ...(typeof total === 'number' ? { totalTokens: total } : {}),
    };
  },
  contentState: () => 'captured',
  // fake.kind: 'tool' -> 'tool'; anything else -> undefined (normalizeTrace falls back to 'other').
  spanKind: (s) => (s.attributes['fake.kind'] === 'tool' ? 'tool' : undefined),
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

// pij.13: extractUsage may report a bare totalTokens (no split); sumTokens must fold it into
// tokens.total without a split from the same span also being present. A same-span
// split+totalTokens double-count guard is not separately asserted here: since the pre-fix
// sumTokens ignores totalTokens entirely, that specific case already yields the same number
// under old and new code, so it cannot be driven red against this baseline (see BUILD report).
describe('sumTokens: bare totalTokens (no split)', () => {
  test('a totalTokens-only span contributes to tokens.total with input/output omitted', () => {
    const tree = buildSpanTree([
      span('a', undefined, 0, { 'fake.dialect': 'a', 'fake.llm': true, 'fake.total': 15 }),
    ]);
    const trace = normalizeTrace(tree, resource(), [dialectA]);

    expect(trace.tokens).toEqual({ total: 15 });
  });

  test('a bare total on one span and a split on another sum together', () => {
    const tree = buildSpanTree([
      span('split', undefined, 0, {
        'fake.dialect': 'a',
        'fake.llm': true,
        'fake.input': 10,
        'fake.output': 5,
      }),
      span('bare', 'split', 10, { 'fake.dialect': 'a', 'fake.llm': true, 'fake.total': 8 }),
    ]);
    const trace = normalizeTrace(tree, resource(), [dialectA]);

    expect(trace.tokens).toEqual({ input: 10, output: 5, total: 23 });
  });
});

describe('normalizeTrace: dialect.spanKind honoured for non-LLM spans', () => {
  test("a non-LLM span maps through the dialect's spanKind hook", () => {
    const tree = buildSpanTree([
      span('a', undefined, 0, { 'fake.dialect': 'a', 'fake.kind': 'tool' }),
    ]);
    const trace = normalizeTrace(tree, resource(), [dialectA]);

    expect(trace.spans).toEqual([{ spanId: 'a', name: 'a', kind: 'tool' }]);
  });
});

// pij.14: dialects keep emitting their own native tool_call/tool_call_response ids;
// normalizeTrace renumbers them afterwards to tool_call_1, tool_call_2... in first-seen call
// order, the same normaliser regardless of which dialect produced the parts.
describe('normalizeTrace: tool_call id normalisation', () => {
  const dialectTools: DialectV1 = {
    name: 'gen_ai',
    detect: (s) => s.attributes['fake.dialect'] === 'tools',
    isLlmSpan: () => true,
    extractMessages: (s) => {
      const messages: Message[] = [];
      const callId = s.attributes['fake.call.id'];
      const responseId = s.attributes['fake.response.id'];
      if (typeof callId === 'string') {
        messages.push({
          role: 'assistant',
          parts: [{ type: 'tool_call', id: callId, name: 'get_weather' }],
        });
      }
      if (typeof responseId === 'string') {
        messages.push({
          role: 'tool',
          parts: [{ type: 'tool_call_response', id: responseId, response: 'ok' }],
        });
      }
      return messages;
    },
    extractUsage: () => null,
    contentState: () => 'captured',
  };

  test('ids become tool_call_1, tool_call_2... in first-seen order; a response follows its call', () => {
    const tree = buildSpanTree([
      span('a', undefined, 0, { 'fake.dialect': 'tools', 'fake.call.id': 'native_a' }),
      span('b', 'a', 10, {
        'fake.dialect': 'tools',
        'fake.call.id': 'native_b',
        'fake.response.id': 'native_a',
      }),
    ]);
    const trace = normalizeTrace(tree, resource(), [dialectTools]);

    expect(trace.messages).toEqual([
      {
        role: 'assistant',
        parts: [{ type: 'tool_call', id: 'tool_call_1', name: 'get_weather' }],
      },
      {
        role: 'assistant',
        parts: [{ type: 'tool_call', id: 'tool_call_2', name: 'get_weather' }],
      },
      {
        role: 'tool',
        parts: [{ type: 'tool_call_response', id: 'tool_call_1', response: 'ok' }],
      },
    ]);
  });

  test('a tool_call part with no id is left without one; other ids are still normalised', () => {
    const dialectNoId: DialectV1 = {
      ...dialectTools,
      extractMessages: () => [
        { role: 'assistant', parts: [{ type: 'tool_call', name: 'no_id_tool' }] },
        { role: 'assistant', parts: [{ type: 'tool_call', id: 'native_x', name: 'get_weather' }] },
      ],
    };
    const tree = buildSpanTree([span('a', undefined, 0, { 'fake.dialect': 'tools' })]);
    const trace = normalizeTrace(tree, resource(), [dialectNoId]);

    expect(trace.messages).toEqual([
      { role: 'assistant', parts: [{ type: 'tool_call', name: 'no_id_tool' }] },
      {
        role: 'assistant',
        parts: [{ type: 'tool_call', id: 'tool_call_1', name: 'get_weather' }],
      },
    ]);
  });

  test('no tool_call parts at all: messages pass through unchanged', () => {
    const tree = buildSpanTree([span('a', undefined, 0, { 'fake.dialect': 'tools' })]);
    const trace = normalizeTrace(tree, resource(), [dialectTools]);
    expect(trace.messages).toEqual([]);
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
