// OpenLLMetry (traceloop) dialect tests (bead mol-pij.5). Spans are built inline — shared
// cross-dialect fixtures belong to pij.9, and this dialect never reads another dialect's keys, so
// there is nothing here to share.

import { describe, expect, test } from 'vitest';
import type { AnyValue, OtlpSpan } from '../../reader/index.ts';
import { openllmetryDialect } from './index.ts';

function span(attributes: Record<string, AnyValue> = {}): OtlpSpan {
  return {
    traceId: '5b8efff798038103d269b633813fc60c',
    spanId: 'a1a1a1a1a1a1a1a1',
    name: 'test-span',
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

describe('openllmetryDialect.name / specCommit', () => {
  test('name is openllmetry', () => {
    expect(openllmetryDialect.name).toBe('openllmetry');
  });

  test('specCommit is a non-empty pinned string', () => {
    expect(typeof openllmetryDialect.specCommit).toBe('string');
    expect(openllmetryDialect.specCommit?.length).toBeGreaterThan(0);
  });
});

describe('detect', () => {
  test('matches on traceloop.span.kind', () => {
    expect(openllmetryDialect.detect(span({ 'traceloop.span.kind': 'llm' }), { attributes: {} })).toBe(
      true,
    );
  });

  test('matches on any traceloop.entity.* key', () => {
    expect(
      openllmetryDialect.detect(span({ 'traceloop.entity.name': 'my_workflow' }), { attributes: {} }),
    ).toBe(true);
  });

  test('matches on llm.prompts.0.role', () => {
    expect(
      openllmetryDialect.detect(span({ 'llm.prompts.0.role': 'user' }), { attributes: {} }),
    ).toBe(true);
  });

  test('does not match when openinference.span.kind is present alongside', () => {
    expect(
      openllmetryDialect.detect(
        span({ 'llm.prompts.0.role': 'user', 'openinference.span.kind': 'LLM' }),
        { attributes: {} },
      ),
    ).toBe(false);
  });

  test('does not match a span with none of the trigger keys', () => {
    expect(openllmetryDialect.detect(span({ 'gen_ai.system': 'openai' }), { attributes: {} })).toBe(
      false,
    );
  });
});

describe('isLlmSpan', () => {
  test('true when traceloop.span.kind is llm', () => {
    expect(openllmetryDialect.isLlmSpan(span({ 'traceloop.span.kind': 'llm' }))).toBe(true);
  });

  test('true when llm.request.type is present', () => {
    expect(openllmetryDialect.isLlmSpan(span({ 'llm.request.type': 'chat' }))).toBe(true);
  });

  test('false for a workflow-kind span', () => {
    expect(openllmetryDialect.isLlmSpan(span({ 'traceloop.span.kind': 'workflow' }))).toBe(false);
  });
});

describe('extractMessages: llm.prompts / llm.completions indexed form', () => {
  test('maps indexed role/content pairs in order', () => {
    const s = span({
      'traceloop.span.kind': 'llm',
      'llm.prompts.0.role': 'system',
      'llm.prompts.0.content': 'you are a vet assistant',
      'llm.prompts.1.role': 'user',
      'llm.prompts.1.content': 'is chocolate toxic to dogs?',
      'llm.completions.0.role': 'assistant',
      'llm.completions.0.content': 'yes, keep it away from dogs',
    });

    const messages = openllmetryDialect.extractMessages(s);

    expect(messages).toEqual([
      { role: 'system', parts: [{ type: 'text', content: 'you are a vet assistant' }] },
      { role: 'user', parts: [{ type: 'text', content: 'is chocolate toxic to dogs?' }] },
      { role: 'assistant', parts: [{ type: 'text', content: 'yes, keep it away from dogs' }] },
    ]);
  });

  test('an unknown role value maps to user', () => {
    const s = span({
      'llm.prompts.0.role': 'narrator',
      'llm.prompts.0.content': 'once upon a time',
    });

    const messages = openllmetryDialect.extractMessages(s);

    expect(messages).toEqual([{ role: 'user', parts: [{ type: 'text', content: 'once upon a time' }] }]);
  });

  test('a structured (non-string) content attribute is accepted as-is after schema validation', () => {
    const s = span({
      'llm.prompts.0.role': 'user',
      'llm.prompts.0.content': [{ type: 'text', content: 'already-structured content' }],
    });

    const messages = openllmetryDialect.extractMessages(s);

    expect(messages).toEqual([{ role: 'user', parts: [{ type: 'text', content: 'already-structured content' }] }]);
  });
});

describe('extractMessages: gen_ai legacy form emitted by traceloop', () => {
  test('maps gen_ai.prompt.{n}.role/.content and gen_ai.completion.{n}.role/.content', () => {
    const s = span({
      'traceloop.span.kind': 'llm',
      'gen_ai.prompt.0.role': 'user',
      'gen_ai.prompt.0.content': 'what is the dosage for a 10kg dog?',
      'gen_ai.completion.0.role': 'assistant',
      'gen_ai.completion.0.content': '5mg twice daily',
    });

    const messages = openllmetryDialect.extractMessages(s);

    expect(messages).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'what is the dosage for a 10kg dog?' }] },
      { role: 'assistant', parts: [{ type: 'text', content: '5mg twice daily' }] },
    ]);
  });
});

describe('extractMessages: traceloop.entity.input/output on a workflow span', () => {
  test('input becomes a user message, output an assistant message', () => {
    const s = span({
      'traceloop.span.kind': 'workflow',
      'traceloop.entity.name': 'triage_workflow',
      'traceloop.entity.input': '{"args":["10kg dog, ate chocolate"],"kwargs":{}}',
      'traceloop.entity.output': '{"risk":"moderate"}',
    });

    const messages = openllmetryDialect.extractMessages(s);

    expect(messages).toEqual([
      {
        role: 'user',
        parts: [{ type: 'text', content: '{"args":["10kg dog, ate chocolate"],"kwargs":{}}' }],
      },
      { role: 'assistant', parts: [{ type: 'text', content: '{"risk":"moderate"}' }] },
    ]);
  });

  test('malformed JSON in traceloop.entity.input yields a parse_error part', () => {
    const s = span({
      'traceloop.span.kind': 'workflow',
      'traceloop.entity.input': '{not valid json',
    });

    const messages = openllmetryDialect.extractMessages(s);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe('user');
    expect(messages[0]?.parts).toHaveLength(1);
    expect(messages[0]?.parts[0]?.type).toBe('parse_error');
  });
});

describe('extractMessages: absent content', () => {
  test('a role without a content attribute still emits a message, with empty parts', () => {
    const s = span({ 'llm.prompts.0.role': 'user' });

    const messages = openllmetryDialect.extractMessages(s);

    expect(messages).toEqual([{ role: 'user', parts: [] }]);
  });

  test('a span with no prompt/completion/entity attributes at all yields no messages', () => {
    const s = span({ 'traceloop.span.kind': 'llm' });

    const messages = openllmetryDialect.extractMessages(s);

    expect(messages).toEqual([]);
  });
});

describe('extractMessages: no cross-dialect fallback', () => {
  test('a mixed-attribute span reflects only this dialect\'s keys', () => {
    const s = span({
      'traceloop.span.kind': 'llm',
      'llm.prompts.0.role': 'user',
      'llm.prompts.0.content': 'openllmetry content',
      // openinference's own content key — must never be read by this dialect.
      'input.value': 'openinference content',
    });

    const messages = openllmetryDialect.extractMessages(s);

    expect(messages).toEqual([{ role: 'user', parts: [{ type: 'text', content: 'openllmetry content' }] }]);
  });
});

describe('extractUsage', () => {
  test('gen_ai.usage.prompt_tokens / .completion_tokens split', () => {
    const usage = openllmetryDialect.extractUsage(
      span({ 'gen_ai.usage.prompt_tokens': 12, 'gen_ai.usage.completion_tokens': 8 }),
    );

    expect(usage).toEqual({ inputTokens: 12, outputTokens: 8 });
  });

  test('llm.usage.total_tokens only: no split, input/output not reported', () => {
    const usage = openllmetryDialect.extractUsage(span({ 'llm.usage.total_tokens': 20 }));

    expect(usage).not.toBeNull();
    expect(usage?.inputTokens).toBeUndefined();
    expect(usage?.outputTokens).toBeUndefined();
  });

  test('no usage attributes at all: null', () => {
    expect(openllmetryDialect.extractUsage(span({}))).toBeNull();
  });
});

describe('contentState', () => {
  test('captured when indexed content is present', () => {
    expect(
      openllmetryDialect.contentState(
        span({ 'llm.prompts.0.role': 'user', 'llm.prompts.0.content': 'hi' }),
      ),
    ).toBe('captured');
  });

  test('captured when traceloop.entity.input is present, even if malformed', () => {
    expect(
      openllmetryDialect.contentState(span({ 'traceloop.entity.input': '{not valid json' })),
    ).toBe('captured');
  });

  test('not_captured when a role is present without content', () => {
    expect(openllmetryDialect.contentState(span({ 'llm.prompts.0.role': 'user' }))).toBe(
      'not_captured',
    );
  });

  test('not_captured when no content-bearing attribute is present at all', () => {
    expect(openllmetryDialect.contentState(span({ 'traceloop.span.kind': 'llm' }))).toBe(
      'not_captured',
    );
  });
});
