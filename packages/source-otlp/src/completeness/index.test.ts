// assessCompleteness tests (bead mol-pij.7): one case per truncation/capture rule (ET brief §4
// OTEL-1, OTEL-3). Fake dialect stands in for the real gen_ai/openinference/etc modules.

import { describe, expect, test } from 'vitest';
import type { AnyValue, OtlpSpan } from '../reader/index.ts';
import { buildSpanTree } from '../reader/tree.ts';
import type { DialectV1 } from '../normalize/dialect.ts';
import { assessCompleteness } from './index.ts';

function span(
  spanId: string,
  attributes: Record<string, AnyValue> = {},
  overrides: Partial<OtlpSpan> = {},
): OtlpSpan {
  return {
    traceId: 'trace-1',
    spanId,
    name: spanId,
    kind: 1,
    startTimeUnixNano: '0',
    endTimeUnixNano: '1000',
    attributes,
    events: [],
    links: [],
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    status: { code: 0 },
    idEncoding: 'hex',
    ...overrides,
  };
}

// isLlmSpan matches attributes.llm === true; contentState reads attributes.state (default
// 'captured'); extractMessages reads attributes.text: undefined -> no messages (legit empty
// conversation), 'PARSE_ERROR' -> a parse_error part, else a text part.
function makeDialect(): DialectV1 {
  return {
    name: 'gen_ai',
    detect: () => true,
    isLlmSpan: (s) => s.attributes['llm'] === true,
    extractMessages: (s) => {
      const text = s.attributes['text'];
      if (text === undefined) return [];
      if (text === 'PARSE_ERROR') {
        return [{ role: 'assistant', parts: [{ type: 'parse_error', detail: 'bad json' }] }];
      }
      return [
        {
          role: 'assistant',
          parts: [{ type: 'text', content: typeof text === 'string' ? text : '' }],
        },
      ];
    },
    extractUsage: () => null,
    contentState: (s) => {
      const state = s.attributes['state'];
      return state === 'not_captured' || state === 'redacted' ? state : 'captured';
    },
  };
}

const dialect = makeDialect();

describe('assessCompleteness: truncated', () => {
  test('droppedAttributesCount > 0 on an LLM span', () => {
    const spans = [span('a', { llm: true }, { droppedAttributesCount: 1 })];
    const result = assessCompleteness(buildSpanTree(spans), spans, dialect);
    expect(result.truncated).toBe(true);
  });

  test('droppedEventsCount > 0 on an LLM span', () => {
    const spans = [span('a', { llm: true }, { droppedEventsCount: 1 })];
    const result = assessCompleteness(buildSpanTree(spans), spans, dialect);
    expect(result.truncated).toBe(true);
  });

  test('flattened attribute count exactly 128', () => {
    const attributes: Record<string, AnyValue> = { llm: true };
    for (let i = 0; i < 127; i += 1) attributes[`attr${i}`] = i;
    const spans = [span('a', attributes)];
    expect(Object.keys(attributes)).toHaveLength(128);
    const result = assessCompleteness(buildSpanTree(spans), spans, dialect);
    expect(result.truncated).toBe(true);
  });

  test('content attribute length exactly 25,000 chars', () => {
    const spans = [span('a', { llm: true, content: 'x'.repeat(25_000) })];
    const result = assessCompleteness(buildSpanTree(spans), spans, dialect);
    expect(result.truncated).toBe(true);
  });

  test('content attribute length exactly 65,536 chars', () => {
    const spans = [span('a', { llm: true, content: 'x'.repeat(65_536) })];
    const result = assessCompleteness(buildSpanTree(spans), spans, dialect);
    expect(result.truncated).toBe(true);
  });

  test('extractMessages yields a parse_error part', () => {
    const spans = [span('a', { llm: true, text: 'PARSE_ERROR' })];
    const result = assessCompleteness(buildSpanTree(spans), spans, dialect);
    expect(result.truncated).toBe(true);
  });

  test('a non-LLM span with dropped attributes does not count', () => {
    const spans = [span('a', {}, { droppedAttributesCount: 1 })];
    const result = assessCompleteness(buildSpanTree(spans), spans, dialect);
    expect(result.truncated).toBe(false);
  });
});

describe('assessCompleteness: contentCaptured', () => {
  test('false when dialect is undefined', () => {
    const spans = [span('a', { llm: true, state: 'captured' })];
    const result = assessCompleteness(buildSpanTree(spans), spans, undefined);
    expect(result.contentCaptured).toBe(false);
    expect(result.truncated).toBe(false);
  });

  test('false when every LLM span is not_captured', () => {
    const spans = [span('a', { llm: true, state: 'not_captured' })];
    const result = assessCompleteness(buildSpanTree(spans), spans, dialect);
    expect(result.contentCaptured).toBe(false);
  });

  test('true when an LLM span is redacted', () => {
    const spans = [span('a', { llm: true, state: 'redacted' })];
    const result = assessCompleteness(buildSpanTree(spans), spans, dialect);
    expect(result.contentCaptured).toBe(true);
  });

  test('legit empty conversation: captured state, no messages -> still captured', () => {
    const spans = [span('a', { llm: true, state: 'captured' })];
    const result = assessCompleteness(buildSpanTree(spans), spans, dialect);
    expect(result.contentCaptured).toBe(true);
    expect(result.truncated).toBe(false);
  });
});

describe('assessCompleteness: missingParents', () => {
  test('passes tree.missingParents through unchanged', () => {
    const spans = [span('child', { llm: true }, { parentSpanId: 'ghost' })];
    const tree = buildSpanTree(spans);
    const result = assessCompleteness(tree, spans, dialect);
    expect(result.missingParents).toEqual(tree.missingParents);
    expect(result.missingParents).toEqual(['ghost']);
  });
});
