// vercelDialect tests (bead mol-pij.6). Spans are built inline; shared cross-dialect fixtures
// belong to pij.9. The outer+inner cascade test exercises the real (unmodified) normalizeTrace
// from ../../normalize/index.ts to prove isLlmSpan alone prevents double counting.

import { describe, expect, test } from 'vitest';
import { buildSpanTree } from '../../reader/tree.ts';
import type { AnyValue, OtlpResource, OtlpSpan } from '../../reader/index.ts';
import { normalizeTrace } from '../../normalize/index.ts';
import { vercelDialect } from './index.ts';

const TRACE = '5b8efff798038103d269b633813fc60c';

function span(
  spanId: string,
  attributes: Record<string, AnyValue> = {},
  parentSpanId?: string,
): OtlpSpan {
  return {
    traceId: TRACE,
    spanId,
    ...(parentSpanId === undefined ? {} : { parentSpanId }),
    name: spanId,
    kind: 1,
    startTimeUnixNano: '1700000000000000000',
    endTimeUnixNano: '1700000001000000000',
    attributes,
    events: [],
    links: [],
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    status: { code: 0 },
    idEncoding: 'hex',
  };
}

function resource(): OtlpResource {
  return { attributes: {} };
}

describe('vercelDialect.detect', () => {
  test('matches on ai.operationId alone', () => {
    expect(
      vercelDialect.detect(span('a', { 'ai.operationId': 'ai.generateText' }), resource()),
    ).toBe(true);
  });

  test('matches on ai.model.id alone', () => {
    expect(vercelDialect.detect(span('a', { 'ai.model.id': 'gpt-4o' }), resource())).toBe(true);
  });

  test('matches on ai.prompt.messages alone', () => {
    expect(vercelDialect.detect(span('a', { 'ai.prompt.messages': '[]' }), resource())).toBe(true);
  });

  test('does not match a span with none of the three keys', () => {
    expect(
      vercelDialect.detect(
        span('a', { 'gen_ai.system': 'openai', 'gen_ai.prompt': 'hi' }),
        resource(),
      ),
    ).toBe(false);
  });
});

describe('vercelDialect.isLlmSpan', () => {
  test.each([
    'ai.generateText.doGenerate',
    'ai.streamText.doStream',
    'ai.generateObject.doGenerate',
    'ai.streamObject.doStream',
  ])('true for inner provider operationId %s', (operationId) => {
    expect(vercelDialect.isLlmSpan(span('inner', { 'ai.operationId': operationId }))).toBe(true);
  });

  test('false for the outer ai.generateText span (not a .doGenerate/.doStream suffix)', () => {
    expect(vercelDialect.isLlmSpan(span('outer', { 'ai.operationId': 'ai.generateText' }))).toBe(
      false,
    );
  });

  test('false for an ai.toolCall span', () => {
    const toolSpan = span('tool', {
      'ai.toolCall.name': 'get_weather',
      'ai.toolCall.args': '{"city":"SF"}',
      'ai.toolCall.result': '{"tempF":70}',
    });
    expect(vercelDialect.isLlmSpan(toolSpan)).toBe(false);
  });

  test("false for Vercel's evaluate span (Jev via AI SDK)", () => {
    expect(
      vercelDialect.isLlmSpan(span('evaluate', { 'ai.operationId': 'ai.evaluate.doEvaluate' })),
    ).toBe(false);
  });
});

describe('vercelDialect.extractMessages', () => {
  test('ai.prompt.messages: JSON string array with plain string content', () => {
    const s = span('inner', {
      'ai.operationId': 'ai.generateText.doGenerate',
      'ai.prompt.messages': JSON.stringify([
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'hi' },
      ]),
    });
    const messages = vercelDialect.extractMessages(s, buildSpanTree([s]));
    expect(messages).toEqual([
      { role: 'system', parts: [{ type: 'text', content: 'be terse' }] },
      { role: 'user', parts: [{ type: 'text', content: 'hi' }] },
    ]);
  });

  test('ai.prompt.messages: content as a parts array reads text parts', () => {
    const s = span('inner', {
      'ai.operationId': 'ai.generateText.doGenerate',
      'ai.prompt.messages': JSON.stringify([
        { role: 'user', content: [{ type: 'text', text: 'part one' }] },
      ]),
    });
    const messages = vercelDialect.extractMessages(s, buildSpanTree([s]));
    expect(messages).toEqual([{ role: 'user', parts: [{ type: 'text', content: 'part one' }] }]);
  });

  test('an unrecognised role maps to user', () => {
    const s = span('inner', {
      'ai.operationId': 'ai.generateText.doGenerate',
      'ai.prompt.messages': JSON.stringify([{ role: 'developer', content: 'hi' }]),
    });
    const messages = vercelDialect.extractMessages(s, buildSpanTree([s]));
    expect(messages[0]?.role).toBe('user');
  });

  test('ai.prompt: plain string becomes one user message', () => {
    const s = span('inner', {
      'ai.operationId': 'ai.generateText.doGenerate',
      'ai.prompt': 'what is the capital of France?',
    });
    const messages = vercelDialect.extractMessages(s, buildSpanTree([s]));
    expect(messages).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'what is the capital of France?' }] },
    ]);
  });

  test('ai.response.text becomes an assistant text part', () => {
    const s = span('inner', {
      'ai.operationId': 'ai.generateText.doGenerate',
      'ai.response.text': 'Paris',
    });
    const messages = vercelDialect.extractMessages(s, buildSpanTree([s]));
    expect(messages).toEqual([{ role: 'assistant', parts: [{ type: 'text', content: 'Paris' }] }]);
  });

  test('ai.response.toolCalls JSON becomes assistant tool_call parts', () => {
    const s = span('inner', {
      'ai.operationId': 'ai.generateText.doGenerate',
      'ai.response.toolCalls': JSON.stringify([
        { toolCallId: 'call_1', toolName: 'get_weather', args: { city: 'SF' } },
      ]),
    });
    const messages = vercelDialect.extractMessages(s, buildSpanTree([s]));
    expect(messages).toEqual([
      {
        role: 'assistant',
        parts: [
          { type: 'tool_call', id: 'call_1', name: 'get_weather', arguments: { city: 'SF' } },
        ],
      },
    ]);
  });

  test('ai.response.object (structured output) becomes one text part with the raw JSON', () => {
    const s = span('inner', {
      'ai.operationId': 'ai.generateObject.doGenerate',
      'ai.response.object': '{"name":"Ada"}',
    });
    const messages = vercelDialect.extractMessages(s, buildSpanTree([s]));
    expect(messages).toEqual([
      { role: 'assistant', parts: [{ type: 'text', content: '{"name":"Ada"}' }] },
    ]);
  });

  test('malformed JSON in ai.prompt.messages yields a parse_error part, not a throw', () => {
    const s = span('inner', {
      'ai.operationId': 'ai.generateText.doGenerate',
      'ai.prompt.messages': '{not valid json',
    });
    const messages = vercelDialect.extractMessages(s, buildSpanTree([s]));
    expect(messages).toHaveLength(1);
    expect(messages[0]?.parts[0]?.type).toBe('parse_error');
  });

  test('malformed JSON in ai.response.toolCalls yields a parse_error part', () => {
    const s = span('inner', {
      'ai.operationId': 'ai.generateText.doGenerate',
      'ai.response.toolCalls': '[not valid',
    });
    const messages = vercelDialect.extractMessages(s, buildSpanTree([s]));
    expect(messages).toEqual([
      { role: 'assistant', parts: [{ type: 'parse_error', detail: expect.any(String) }] },
    ]);
  });

  test('recordInputs:false / recordOutputs:false (no content attributes) yields no messages', () => {
    const s = span('inner', { 'ai.operationId': 'ai.generateText.doGenerate' });
    expect(vercelDialect.extractMessages(s, buildSpanTree([s]))).toEqual([]);
  });

  test('only ai.model.id present (no content attributes) yields no messages', () => {
    const s = span('inner', {
      'ai.operationId': 'ai.generateText.doGenerate',
      'ai.model.id': 'gpt-4o',
    });
    expect(vercelDialect.extractMessages(s, buildSpanTree([s]))).toEqual([]);
  });

  test("never reads another dialect's attributes (no cross-dialect fallback)", () => {
    const s = span('inner', {
      'ai.operationId': 'ai.generateText.doGenerate',
      'ai.prompt': 'vercel prompt',
      'gen_ai.prompt': 'other-dialect prompt',
      'gen_ai.system': 'openai',
    });
    const messages = vercelDialect.extractMessages(s, buildSpanTree([s]));
    expect(messages).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'vercel prompt' }] },
    ]);
  });
});

describe('vercelDialect.extractUsage', () => {
  test('reads ai.usage.promptTokens / completionTokens', () => {
    const s = span('inner', { 'ai.usage.promptTokens': 10, 'ai.usage.completionTokens': 5 });
    expect(vercelDialect.extractUsage(s)).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  test('v5+: reads ai.usage.inputTokens / outputTokens when promptTokens/completionTokens absent', () => {
    const s = span('inner', { 'ai.usage.inputTokens': 7, 'ai.usage.outputTokens': 3 });
    expect(vercelDialect.extractUsage(s)).toEqual({ inputTokens: 7, outputTokens: 3 });
  });

  test('both vocabularies present: reads only one, never both', () => {
    const s = span('inner', {
      'ai.usage.promptTokens': 10,
      'ai.usage.completionTokens': 5,
      'ai.usage.inputTokens': 999,
      'ai.usage.outputTokens': 999,
    });
    expect(vercelDialect.extractUsage(s)).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  test('no usage attributes: returns null', () => {
    expect(vercelDialect.extractUsage(span('inner', { 'ai.operationId': 'ai.generateText' }))).toBe(
      null,
    );
  });
});

describe('vercelDialect.contentState', () => {
  test('captured when a content attribute is present', () => {
    expect(vercelDialect.contentState(span('inner', { 'ai.prompt': 'hi' }))).toBe('captured');
  });

  test('captured even when that content attribute is malformed JSON (attribute was present)', () => {
    expect(vercelDialect.contentState(span('inner', { 'ai.prompt.messages': '{not valid' }))).toBe(
      'captured',
    );
  });

  test('not_captured when no content attribute is present', () => {
    expect(
      vercelDialect.contentState(span('inner', { 'ai.operationId': 'ai.generateText.doGenerate' })),
    ).toBe('not_captured');
  });
});

describe('vercelDialect.specCommit', () => {
  test('is a pinned, non-empty string', () => {
    expect(typeof vercelDialect.specCommit).toBe('string');
    expect(vercelDialect.specCommit?.length).toBeGreaterThan(0);
  });
});

describe('vercelDialect wired through normalizeTrace (outer+inner span pair)', () => {
  test('the outer span never contributes to isLlmSpan-gated token summation, even carrying its own usage copy', () => {
    const outer = span('outer', {
      'ai.operationId': 'ai.generateText',
      'ai.usage.promptTokens': 10,
      'ai.usage.completionTokens': 5,
    });
    const inner = span(
      'inner',
      {
        'ai.operationId': 'ai.generateText.doGenerate',
        'ai.usage.promptTokens': 10,
        'ai.usage.completionTokens': 5,
      },
      'outer',
    );
    const tree = buildSpanTree([outer, inner]);
    const trace = normalizeTrace(tree, resource(), [vercelDialect]);

    expect(trace.dialect).toBe('vercel');
    expect(trace.tokens).toEqual({ input: 10, output: 5, total: 15 });
    expect(trace.spans).toEqual([
      { spanId: 'outer', name: 'outer', kind: 'other' },
      { spanId: 'inner', name: 'inner', kind: 'llm', messageRange: [0, 0] },
    ]);
  });
});
