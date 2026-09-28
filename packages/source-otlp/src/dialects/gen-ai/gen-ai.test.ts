// gen_ai dialect tests (bead mol-pij.3): two DialectV1 objects for the OTel GenAI semantic
// conventions — genAiDialect (latest gen_ai.input.messages/output.messages/system_instructions)
// and genAiLegacyDialect (legacy indexed gen_ai.prompt.{n}/completion.{n} attributes and the
// gen_ai.content.prompt/completion span events). Cascade, detection order and completeness
// flags are owned elsewhere (pij.2, pij.7, pij.11); this file only exercises the two dialects
// in isolation.

import { describe, expect, test } from 'vitest';
import type { AnyValue, OtlpEvent, OtlpSpan } from '../../reader/index.ts';
import { buildSpanTree } from '../../reader/tree.ts';
import { genAiDialect, genAiLegacyDialect } from './index.ts';

function span(attributes: Record<string, AnyValue> = {}, events: OtlpEvent[] = []): OtlpSpan {
  return {
    traceId: '5b8efff798038103d269b633813fc60c',
    spanId: 's1',
    name: 'chat gpt-4',
    kind: 1,
    startTimeUnixNano: '1700000000000000000',
    endTimeUnixNano: '1700000001000000000',
    attributes,
    events,
    links: [],
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    status: { code: 0 },
    idEncoding: 'hex',
  };
}

function event(name: string, attributes: Record<string, AnyValue> = {}): OtlpEvent {
  return { timeUnixNano: '1700000000500000000', name, attributes, droppedAttributesCount: 0 };
}

const tree = buildSpanTree([span()]);

describe('genAiDialect.detect', () => {
  test('operation.name plus gen_ai.input.messages', () => {
    const s = span({ 'gen_ai.operation.name': 'chat', 'gen_ai.input.messages': '[]' });
    expect(genAiDialect.detect(s, { attributes: {} })).toBe(true);
  });

  test('operation.name plus gen_ai.system_instructions', () => {
    const s = span({ 'gen_ai.operation.name': 'chat', 'gen_ai.system_instructions': '[]' });
    expect(genAiDialect.detect(s, { attributes: {} })).toBe(true);
  });

  test('operation.name without any latest content key: no match', () => {
    const s = span({ 'gen_ai.operation.name': 'chat' });
    expect(genAiDialect.detect(s, { attributes: {} })).toBe(false);
  });

  test('legacy-only span: no match', () => {
    const s = span({
      'gen_ai.operation.name': 'chat',
      'gen_ai.prompt.0.role': 'user',
      'gen_ai.prompt.0.content': 'hi',
    });
    expect(genAiDialect.detect(s, { attributes: {} })).toBe(false);
  });
});

describe('genAiLegacyDialect.detect', () => {
  test('operation.name plus indexed prompt attributes', () => {
    const s = span({
      'gen_ai.operation.name': 'chat',
      'gen_ai.prompt.0.role': 'user',
      'gen_ai.prompt.0.content': 'hi',
    });
    expect(genAiLegacyDialect.detect(s, { attributes: {} })).toBe(true);
  });

  test('operation.name plus gen_ai.content.prompt event', () => {
    const s = span({ 'gen_ai.operation.name': 'chat' }, [event('gen_ai.content.prompt')]);
    expect(genAiLegacyDialect.detect(s, { attributes: {} })).toBe(true);
  });

  test('latest-only span: no match', () => {
    const s = span({ 'gen_ai.operation.name': 'chat', 'gen_ai.input.messages': '[]' });
    expect(genAiLegacyDialect.detect(s, { attributes: {} })).toBe(false);
  });
});

describe('isLlmSpan (shared rule)', () => {
  test('operation.name in {chat, text_completion, generate_content}', () => {
    expect(genAiDialect.isLlmSpan(span({ 'gen_ai.operation.name': 'chat' }))).toBe(true);
    expect(genAiDialect.isLlmSpan(span({ 'gen_ai.operation.name': 'text_completion' }))).toBe(true);
    expect(genAiDialect.isLlmSpan(span({ 'gen_ai.operation.name': 'generate_content' }))).toBe(
      true,
    );
  });

  test('operation.name outside the set: false', () => {
    expect(genAiDialect.isLlmSpan(span({ 'gen_ai.operation.name': 'execute_tool' }))).toBe(false);
    expect(genAiDialect.isLlmSpan(span({ 'gen_ai.operation.name': 'embeddings' }))).toBe(false);
  });

  test('no operation.name attribute: span name prefix decides', () => {
    const s: OtlpSpan = { ...span(), name: 'chat gpt-4o', attributes: {} };
    expect(genAiDialect.isLlmSpan(s)).toBe(true);
    const other: OtlpSpan = { ...span(), name: 'retrieve docs', attributes: {} };
    expect(genAiDialect.isLlmSpan(other)).toBe(false);
  });

  test('same rule on the legacy dialect', () => {
    expect(genAiLegacyDialect.isLlmSpan(span({ 'gen_ai.operation.name': 'chat' }))).toBe(true);
    expect(genAiLegacyDialect.isLlmSpan(span({ 'gen_ai.operation.name': 'embeddings' }))).toBe(
      false,
    );
  });
});

describe('genAiDialect.extractMessages: latest JSON-string messages', () => {
  test('input.messages + output.messages + system_instructions, all JSON strings', () => {
    const s = span({
      'gen_ai.system_instructions': JSON.stringify([{ type: 'text', content: 'be nice' }]),
      'gen_ai.input.messages': JSON.stringify([
        { role: 'user', parts: [{ type: 'text', content: 'hi' }] },
      ]),
      'gen_ai.output.messages': JSON.stringify([
        { role: 'assistant', parts: [{ type: 'text', content: 'hello' }] },
      ]),
    });

    expect(genAiDialect.extractMessages(s, tree)).toEqual([
      { role: 'system', parts: [{ type: 'text', content: 'be nice' }] },
      { role: 'user', parts: [{ type: 'text', content: 'hi' }] },
      { role: 'assistant', parts: [{ type: 'text', content: 'hello' }] },
    ]);
  });
});

describe('genAiDialect.extractMessages: latest structured messages', () => {
  test('input.messages as an already-parsed array (AnyValue), not a string', () => {
    const s = span({
      'gen_ai.input.messages': [
        { role: 'user', parts: [{ type: 'text', content: 'structured hi' }] },
      ] as AnyValue,
    });

    expect(genAiDialect.extractMessages(s, tree)).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'structured hi' }] },
    ]);
  });
});

describe('genAiDialect.extractMessages: tool_call parts round-trip', () => {
  test('output.messages tool_call + input.messages tool_call_response, ids preserved', () => {
    const s = span({
      'gen_ai.input.messages': JSON.stringify([
        {
          role: 'tool',
          parts: [{ type: 'tool_call_response', id: 'call_1', response: { ok: true } }],
        },
      ]),
      'gen_ai.output.messages': JSON.stringify([
        {
          role: 'assistant',
          parts: [
            { type: 'tool_call', id: 'call_1', name: 'get_weather', arguments: { city: 'NYC' } },
          ],
        },
      ]),
    });

    expect(genAiDialect.extractMessages(s, tree)).toEqual([
      {
        role: 'tool',
        parts: [{ type: 'tool_call_response', id: 'call_1', response: { ok: true } }],
      },
      {
        role: 'assistant',
        parts: [
          { type: 'tool_call', id: 'call_1', name: 'get_weather', arguments: { city: 'NYC' } },
        ],
      },
    ]);
  });

  test('execute_tool span: flat gen_ai.tool.call.arguments/result attributes', () => {
    const s = span({
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': 'get_weather',
      'gen_ai.tool.call.id': 'call_2',
      'gen_ai.tool.call.arguments': { city: 'SF' },
      'gen_ai.tool.call.result': { tempF: 60 },
    });

    expect(genAiDialect.extractMessages(s, tree)).toEqual([
      {
        role: 'tool',
        parts: [
          { type: 'tool_call', id: 'call_2', name: 'get_weather', arguments: { city: 'SF' } },
          { type: 'tool_call_response', id: 'call_2', response: { tempF: 60 } },
        ],
      },
    ]);
  });
});

describe('genAiDialect.extractMessages: reasoning parts are dropped (root DECISION)', () => {
  // Root DECISION: the trace IR MessagePart set is text{content} / tool_call /
  // tool_call_response{id?,response} / parse_error{detail}; reasoning parts are DROPPED, not
  // downgraded to text.
  test('a reasoning part is dropped, sibling parts in the same message survive', () => {
    const s = span({
      'gen_ai.output.messages': JSON.stringify([
        {
          role: 'assistant',
          parts: [
            { type: 'reasoning', content: 'thinking it through' },
            { type: 'text', content: 'final answer' },
          ],
        },
      ]),
    });

    expect(genAiDialect.extractMessages(s, tree)).toEqual([
      { role: 'assistant', parts: [{ type: 'text', content: 'final answer' }] },
    ]);
  });

  test('a message containing only a reasoning part yields no message at all', () => {
    const s = span({
      'gen_ai.output.messages': JSON.stringify([
        { role: 'assistant', parts: [{ type: 'reasoning', content: 'thinking it through' }] },
      ]),
    });

    expect(genAiDialect.extractMessages(s, tree)).toEqual([]);
  });
});

describe('genAiDialect.extractMessages: other unmapped part kinds still downgrade to text', () => {
  test('a non-reasoning unknown part kind is still mapped to a text part', () => {
    const s = span({
      'gen_ai.output.messages': JSON.stringify([
        { role: 'assistant', parts: [{ type: 'audio', content: 'transcribed audio' }] },
      ]),
    });

    expect(genAiDialect.extractMessages(s, tree)).toEqual([
      { role: 'assistant', parts: [{ type: 'text', content: 'transcribed audio' }] },
    ]);
  });
});

describe('genAiDialect.extractMessages: malformed JSON', () => {
  test('invalid JSON string yields a parse_error part, not a throw', () => {
    const s = span({ 'gen_ai.input.messages': '{not valid json' });

    const messages = genAiDialect.extractMessages(s, tree);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.parts[0]?.type).toBe('parse_error');
  });

  test('contentState is captured (attribute present) even though parsing failed', () => {
    const s = span({ 'gen_ai.input.messages': '{not valid json' });
    expect(genAiDialect.contentState(s)).toBe('captured');
  });
});

describe('genAiDialect: absent content', () => {
  test('no input/output/system_instructions attrs: contentState not_captured, no messages', () => {
    const s = span({ 'gen_ai.operation.name': 'chat' });
    expect(genAiDialect.contentState(s)).toBe('not_captured');
    expect(genAiDialect.extractMessages(s, tree)).toEqual([]);
  });
});

describe('genAiDialect.extractUsage', () => {
  test('reads gen_ai.usage.input_tokens/output_tokens', () => {
    const s = span({ 'gen_ai.usage.input_tokens': 12, 'gen_ai.usage.output_tokens': 34 });
    expect(genAiDialect.extractUsage(s)).toEqual({ inputTokens: 12, outputTokens: 34 });
  });

  test('neither usage attribute present: null', () => {
    expect(genAiDialect.extractUsage(span())).toBeNull();
  });

  test('cache-token attributes ignored without error', () => {
    const s = span({
      'gen_ai.usage.input_tokens': 12,
      'gen_ai.usage.output_tokens': 34,
      'gen_ai.usage.cache_creation.input_tokens': 100,
      'gen_ai.usage.cache_read_input_tokens': 50,
    });
    expect(() => genAiDialect.extractUsage(s)).not.toThrow();
    expect(genAiDialect.extractUsage(s)).toEqual({ inputTokens: 12, outputTokens: 34 });
  });
});

describe('genAiLegacyDialect.extractMessages: indexed attributes', () => {
  test('gen_ai.prompt.{n} then gen_ai.completion.{n}, ordered by index', () => {
    const s = span({
      'gen_ai.prompt.0.role': 'system',
      'gen_ai.prompt.0.content': 'be nice',
      'gen_ai.prompt.1.role': 'user',
      'gen_ai.prompt.1.content': 'hi',
      'gen_ai.completion.0.role': 'assistant',
      'gen_ai.completion.0.content': 'hello',
    });

    expect(genAiLegacyDialect.extractMessages(s, tree)).toEqual([
      { role: 'system', parts: [{ type: 'text', content: 'be nice' }] },
      { role: 'user', parts: [{ type: 'text', content: 'hi' }] },
      { role: 'assistant', parts: [{ type: 'text', content: 'hello' }] },
    ]);
  });

  test('missing role on a prompt index falls back to user, on a completion index to assistant', () => {
    const s = span({
      'gen_ai.prompt.0.content': 'hi',
      'gen_ai.completion.0.content': 'hello',
    });

    expect(genAiLegacyDialect.extractMessages(s, tree)).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'hi' }] },
      { role: 'assistant', parts: [{ type: 'text', content: 'hello' }] },
    ]);
  });

  test('unknown role value maps to user', () => {
    const s = span({ 'gen_ai.prompt.0.role': 'weird', 'gen_ai.prompt.0.content': 'hi' });
    expect(genAiLegacyDialect.extractMessages(s, tree)).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'hi' }] },
    ]);
  });
});

// pij.14: gen_ai.{prompt,completion}.{n}.tool_calls.{i}.{id,name,arguments} (an assistant turn
// calling a tool) and gen_ai.{prompt,completion}.{n}.tool_call_id (a tool turn responding to one)
// map onto tool_call / tool_call_response parts instead of text.
describe('genAiLegacyDialect.extractMessages: tool calls (indexed attrs)', () => {
  test('completion.{n}.tool_calls.{i}.{id,name,arguments}: a tool_call part after any text', () => {
    const s = span({
      'gen_ai.completion.0.role': 'assistant',
      'gen_ai.completion.0.content': "I'll check the weather.",
      'gen_ai.completion.0.tool_calls.0.id': 'call_1',
      'gen_ai.completion.0.tool_calls.0.name': 'get_weather',
      'gen_ai.completion.0.tool_calls.0.arguments': '{"city":"Paris"}',
    });

    expect(genAiLegacyDialect.extractMessages(s, tree)).toEqual([
      {
        role: 'assistant',
        parts: [
          { type: 'text', content: "I'll check the weather." },
          { type: 'tool_call', id: 'call_1', name: 'get_weather', arguments: '{"city":"Paris"}' },
        ],
      },
    ]);
  });

  test('prompt.{n}.tool_call_id: content becomes a tool_call_response, not text', () => {
    const s = span({
      'gen_ai.prompt.0.role': 'tool',
      'gen_ai.prompt.0.tool_call_id': 'call_1',
      'gen_ai.prompt.0.content': '{"temp_c":18}',
    });

    expect(genAiLegacyDialect.extractMessages(s, tree)).toEqual([
      {
        role: 'tool',
        parts: [{ type: 'tool_call_response', id: 'call_1', response: '{"temp_c":18}' }],
      },
    ]);
  });

  test('multiple tool_calls at one index are ordered by their own sub-index', () => {
    const s = span({
      'gen_ai.completion.0.role': 'assistant',
      'gen_ai.completion.0.content': 'using two tools',
      'gen_ai.completion.0.tool_calls.1.id': 'call_2',
      'gen_ai.completion.0.tool_calls.1.name': 'get_time',
      'gen_ai.completion.0.tool_calls.0.id': 'call_1',
      'gen_ai.completion.0.tool_calls.0.name': 'get_weather',
    });

    expect(genAiLegacyDialect.extractMessages(s, tree)).toEqual([
      {
        role: 'assistant',
        parts: [
          { type: 'text', content: 'using two tools' },
          { type: 'tool_call', id: 'call_1', name: 'get_weather' },
          { type: 'tool_call', id: 'call_2', name: 'get_time' },
        ],
      },
    ]);
  });

  test('a tool_call missing its function name is skipped', () => {
    const s = span({
      'gen_ai.completion.0.role': 'assistant',
      'gen_ai.completion.0.tool_calls.0.id': 'call_1',
    });

    expect(genAiLegacyDialect.extractMessages(s, tree)).toEqual([
      { role: 'assistant', parts: [{ type: 'text', content: '' }] },
    ]);
  });
});

describe('genAiLegacyDialect.extractMessages: legacy content events', () => {
  test('gen_ai.content.prompt / gen_ai.content.completion events with a JSON body', () => {
    const s = span({}, [
      event('gen_ai.content.prompt', {
        'gen_ai.prompt': JSON.stringify([{ role: 'user', content: 'hi' }]),
      }),
      event('gen_ai.content.completion', {
        'gen_ai.completion': JSON.stringify([{ role: 'assistant', content: 'hello' }]),
      }),
    ]);

    expect(genAiLegacyDialect.extractMessages(s, tree)).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'hi' }] },
      { role: 'assistant', parts: [{ type: 'text', content: 'hello' }] },
    ]);
  });
});

describe('genAiLegacyDialect: absent content', () => {
  test('no indexed attrs and no content events: contentState not_captured, no messages', () => {
    const s = span({ 'gen_ai.operation.name': 'chat' });
    expect(genAiLegacyDialect.contentState(s)).toBe('not_captured');
    expect(genAiLegacyDialect.extractMessages(s, tree)).toEqual([]);
  });
});

describe('genAiLegacyDialect.extractUsage', () => {
  test('reads gen_ai.usage.prompt_tokens/completion_tokens', () => {
    const s = span({ 'gen_ai.usage.prompt_tokens': 5, 'gen_ai.usage.completion_tokens': 6 });
    expect(genAiLegacyDialect.extractUsage(s)).toEqual({ inputTokens: 5, outputTokens: 6 });
  });
});

describe('cross-dialect isolation: never reads the other dialect', () => {
  const mixed = span({
    'gen_ai.input.messages': JSON.stringify([
      { role: 'user', parts: [{ type: 'text', content: 'latest' }] },
    ]),
    'gen_ai.prompt.0.role': 'user',
    'gen_ai.prompt.0.content': 'legacy',
    'gen_ai.usage.input_tokens': 100,
    'gen_ai.usage.prompt_tokens': 999,
  });

  test('genAiDialect consumes only its own keys', () => {
    expect(genAiDialect.extractMessages(mixed, tree)).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'latest' }] },
    ]);
    expect(genAiDialect.extractUsage(mixed)).toEqual({ inputTokens: 100 });
  });

  test('genAiLegacyDialect consumes only its own keys', () => {
    expect(genAiLegacyDialect.extractMessages(mixed, tree)).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'legacy' }] },
    ]);
    expect(genAiLegacyDialect.extractUsage(mixed)).toEqual({ inputTokens: 999 });
  });
});

describe('specCommit', () => {
  test('both dialects pin a spec commit', () => {
    expect(typeof genAiDialect.specCommit).toBe('string');
    expect(typeof genAiLegacyDialect.specCommit).toBe('string');
  });
});
