// openinference dialect tests (bead mol-pij.4). Attribute names per
// https://github.com/Arize-ai/openinference/blob/7feb0c4ba2fd77cb76036712e21d06ff15a2be22/spec/semantic_conventions.md
// (pinned commit, matches SPEC_COMMIT in ./index.ts).

import { describe, expect, test } from 'vitest';
import type { AnyValue, OtlpResource, OtlpSpan } from '../../reader/index.ts';
import { buildSpanTree } from '../../reader/tree.ts';
import { openinferenceDialect } from './index.ts';

const TRACE = '5b8efff798038103d269b633813fc60c';

function span(spanId: string, attributes: Record<string, AnyValue> = {}): OtlpSpan {
  return {
    traceId: TRACE,
    spanId,
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

const resource: OtlpResource = { attributes: {} };

function tree(s: OtlpSpan) {
  return buildSpanTree([s]);
}

describe('openinferenceDialect.detect', () => {
  test('true when openinference.span.kind is present, whatever its value', () => {
    expect(
      openinferenceDialect.detect(span('a', { 'openinference.span.kind': 'CHAIN' }), resource),
    ).toBe(true);
  });

  test('false when openinference.span.kind is absent', () => {
    expect(openinferenceDialect.detect(span('a', { 'gen_ai.system': 'openai' }), resource)).toBe(
      false,
    );
  });
});

describe('openinferenceDialect.isLlmSpan', () => {
  test('true only for kind LLM', () => {
    expect(openinferenceDialect.isLlmSpan(span('a', { 'openinference.span.kind': 'LLM' }))).toBe(
      true,
    );
  });

  test('false for a TOOL span', () => {
    expect(openinferenceDialect.isLlmSpan(span('a', { 'openinference.span.kind': 'TOOL' }))).toBe(
      false,
    );
  });
});

describe('openinferenceDialect.extractMessages — indexed messages', () => {
  test('maps indexed input and output messages, in order, unknown role falls back to user', () => {
    const s = span('a', {
      'openinference.span.kind': 'LLM',
      'llm.input_messages.0.message.role': 'system',
      'llm.input_messages.0.message.content': 'be terse',
      'llm.input_messages.1.message.role': 'user',
      'llm.input_messages.1.message.content': 'hi',
      'llm.input_messages.2.message.role': 'narrator',
      'llm.input_messages.2.message.content': 'an unknown role',
      'llm.output_messages.0.message.role': 'assistant',
      'llm.output_messages.0.message.content': 'hello',
    });
    expect(openinferenceDialect.extractMessages(s, tree(s))).toEqual([
      { role: 'system', parts: [{ type: 'text', content: 'be terse' }] },
      { role: 'user', parts: [{ type: 'text', content: 'hi' }] },
      { role: 'user', parts: [{ type: 'text', content: 'an unknown role' }] },
      { role: 'assistant', parts: [{ type: 'text', content: 'hello' }] },
    ]);
  });
});

describe('openinferenceDialect.extractMessages — tool_calls', () => {
  test('maps indexed message.tool_calls to tool_call parts', () => {
    const s = span('a', {
      'openinference.span.kind': 'LLM',
      'llm.output_messages.0.message.role': 'assistant',
      'llm.output_messages.0.message.tool_calls.0.tool_call.id': 'call_1',
      'llm.output_messages.0.message.tool_calls.0.tool_call.function.name': 'get_current_weather',
      'llm.output_messages.0.message.tool_calls.0.tool_call.function.arguments':
        "{'city': 'London'}",
    });
    expect(openinferenceDialect.extractMessages(s, tree(s))).toEqual([
      {
        role: 'assistant',
        parts: [
          {
            type: 'tool_call',
            id: 'call_1',
            name: 'get_current_weather',
            arguments: "{'city': 'London'}",
          },
        ],
      },
    ]);
  });
});

// pij.14: an indexed message carrying message.tool_call_id (a tool turn responding to a call)
// maps to a tool_call_response part, not the text part its message.content would otherwise get.
describe('openinferenceDialect.extractMessages — message.tool_call_id', () => {
  test('a tool_call_id turns message.content into a tool_call_response, not text', () => {
    const s = span('a', {
      'openinference.span.kind': 'LLM',
      'llm.input_messages.0.message.role': 'tool',
      'llm.input_messages.0.message.tool_call_id': 'call_1',
      'llm.input_messages.0.message.content': '{"temp_c":18}',
    });
    expect(openinferenceDialect.extractMessages(s, tree(s))).toEqual([
      {
        role: 'tool',
        parts: [{ type: 'tool_call_response', id: 'call_1', response: '{"temp_c":18}' }],
      },
    ]);
  });

  test('a tool_call_id message still gets its sibling tool_calls parts (round-trip on one span)', () => {
    const s = span('a', {
      'openinference.span.kind': 'LLM',
      'llm.output_messages.0.message.role': 'assistant',
      'llm.output_messages.0.message.tool_calls.0.tool_call.id': 'call_1',
      'llm.output_messages.0.message.tool_calls.0.tool_call.function.name': 'get_weather',
      'llm.input_messages.0.message.role': 'tool',
      'llm.input_messages.0.message.tool_call_id': 'call_1',
      'llm.input_messages.0.message.content': '{"temp_c":18}',
    });
    expect(openinferenceDialect.extractMessages(s, tree(s))).toEqual([
      {
        role: 'tool',
        parts: [{ type: 'tool_call_response', id: 'call_1', response: '{"temp_c":18}' }],
      },
      {
        role: 'assistant',
        parts: [{ type: 'tool_call', id: 'call_1', name: 'get_weather' }],
      },
    ]);
  });
});

describe('openinferenceDialect.extractMessages — input.value fallback', () => {
  test('text/plain input.value with no indexed messages becomes one user message', () => {
    const s = span('a', {
      'openinference.span.kind': 'LLM',
      'input.value': 'what is the weather today?',
      'input.mime_type': 'text/plain',
    });
    expect(openinferenceDialect.extractMessages(s, tree(s))).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'what is the weather today?' }] },
    ]);
  });

  test('application/json input.value that validates as a message list is used as-is', () => {
    const s = span('a', {
      'openinference.span.kind': 'LLM',
      'input.value': JSON.stringify([{ role: 'user', parts: [{ type: 'text', content: 'hi' }] }]),
      'input.mime_type': 'application/json',
    });
    expect(openinferenceDialect.extractMessages(s, tree(s))).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'hi' }] },
    ]);
  });

  test('application/json input.value with invalid JSON syntax becomes a parse_error part', () => {
    const s = span('a', {
      'openinference.span.kind': 'LLM',
      'input.value': '{not json',
      'input.mime_type': 'application/json',
    });
    const messages = openinferenceDialect.extractMessages(s, tree(s));
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe('user');
    expect(messages[0]?.parts).toHaveLength(1);
    expect(messages[0]?.parts[0]?.type).toBe('parse_error');
  });

  test('application/json input.value that is valid JSON but not a message list becomes one text part', () => {
    const s = span('a', {
      'openinference.span.kind': 'LLM',
      'input.value': JSON.stringify({ query: 'What is the weather today?' }),
      'input.mime_type': 'application/json',
    });
    expect(openinferenceDialect.extractMessages(s, tree(s))).toEqual([
      {
        role: 'user',
        parts: [{ type: 'text', content: JSON.stringify({ query: 'What is the weather today?' }) }],
      },
    ]);
  });

  test('output.value falls back independently of input.value, as one assistant message', () => {
    const s = span('a', {
      'openinference.span.kind': 'LLM',
      'output.value': 'Hello, World!',
      'output.mime_type': 'text/plain',
    });
    expect(openinferenceDialect.extractMessages(s, tree(s))).toEqual([
      { role: 'assistant', parts: [{ type: 'text', content: 'Hello, World!' }] },
    ]);
  });
});

describe('openinferenceDialect.extractMessages — absent content', () => {
  test('an LLM span with none of the mapped keys yields no messages', () => {
    const s = span('a', { 'openinference.span.kind': 'LLM' });
    expect(openinferenceDialect.extractMessages(s, tree(s))).toEqual([]);
    expect(openinferenceDialect.contentState(s)).toBe('not_captured');
  });

  test('a TOOL span with none of tool.name/input.value/output.value yields no messages', () => {
    const s = span('a', { 'openinference.span.kind': 'TOOL' });
    expect(openinferenceDialect.extractMessages(s, tree(s))).toEqual([]);
    expect(openinferenceDialect.contentState(s)).toBe('not_captured');
  });
});

describe('openinferenceDialect.extractMessages — TOOL span mapping', () => {
  test('maps tool.name / input.value / output.value to a tool_call and a tool_call_response message', () => {
    const s = span('a', {
      'openinference.span.kind': 'TOOL',
      'tool.name': 'get_current_weather',
      'input.value': "{'city': 'London'}",
      'output.value': "{'temp_f': 55}",
    });
    expect(openinferenceDialect.extractMessages(s, tree(s))).toEqual([
      {
        role: 'assistant',
        parts: [
          { type: 'tool_call', name: 'get_current_weather', arguments: "{'city': 'London'}" },
        ],
      },
      { role: 'tool', parts: [{ type: 'tool_call_response', response: "{'temp_f': 55}" }] },
    ]);
    expect(openinferenceDialect.contentState(s)).toBe('captured');
  });
});

describe('openinferenceDialect.extractUsage', () => {
  test('reads llm.token_count.prompt and llm.token_count.completion', () => {
    const s = span('a', {
      'openinference.span.kind': 'LLM',
      'llm.token_count.prompt': 10,
      'llm.token_count.completion': 15,
    });
    expect(openinferenceDialect.extractUsage(s)).toEqual({ inputTokens: 10, outputTokens: 15 });
  });

  test('returns a partial object when only one side is present', () => {
    const s = span('a', { 'openinference.span.kind': 'LLM', 'llm.token_count.prompt': 10 });
    expect(openinferenceDialect.extractUsage(s)).toEqual({ inputTokens: 10 });
  });

  test('returns null when neither token count is present', () => {
    const s = span('a', { 'openinference.span.kind': 'LLM' });
    expect(openinferenceDialect.extractUsage(s)).toBeNull();
  });
});

describe('openinferenceDialect — cross-dialect isolation', () => {
  test('a span carrying both OpenInference and gen_ai.* keys is read only through OpenInference keys', () => {
    const s = span('a', {
      'openinference.span.kind': 'LLM',
      'llm.input_messages.0.message.role': 'user',
      'llm.input_messages.0.message.content': 'hi',
      'llm.token_count.prompt': 10,
      // gen_ai.* attributes that would produce different output if this dialect read them.
      'gen_ai.system': 'openai',
      'gen_ai.prompt.0.content': 'a gen_ai-only message that must not appear',
      'gen_ai.usage.input_tokens': 999,
    });
    expect(openinferenceDialect.extractMessages(s, tree(s))).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'hi' }] },
    ]);
    expect(openinferenceDialect.extractUsage(s)).toEqual({ inputTokens: 10 });
  });
});

describe('openinferenceDialect metadata', () => {
  test('name is openinference', () => {
    expect(openinferenceDialect.name).toBe('openinference');
  });

  test('specCommit is a pinned non-empty commit reference', () => {
    expect(openinferenceDialect.specCommit).toMatch(/^[0-9a-f]{40}$/);
  });
});
