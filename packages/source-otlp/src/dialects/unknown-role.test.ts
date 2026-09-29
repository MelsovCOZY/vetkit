// Every built-in dialect reports an unknown message role through the optional diag callback of
// extractMessages: one diag naming the role and the span id, never the message content.

import { describe, expect, test } from 'vitest';
import type { OtlpDiag } from '../normalize/dialect.ts';
import type { DialectV1 } from '../normalize/dialect.ts';
import type { AnyValue, OtlpSpan } from '../reader/index.ts';
import { buildSpanTree } from '../reader/tree.ts';
import { genAiDialect, genAiLegacyDialect } from './gen-ai/index.ts';
import { openinferenceDialect } from './openinference/index.ts';
import { openllmetryDialect } from './openllmetry/index.ts';
import { vercelDialect } from './vercel/index.ts';

const SPAN_ID = 'abcdef0123456789';
const SECRET = 'the-message-content-must-not-leak';

function span(attributes: Record<string, AnyValue>): OtlpSpan {
  return {
    traceId: '5b8efff798038103d269b633813fc60c',
    spanId: SPAN_ID,
    name: 'chat',
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

interface Case {
  readonly dialect: DialectV1;
  readonly attrs: (role: string) => Record<string, AnyValue>;
}

const cases: Record<string, Case> = {
  gen_ai: {
    dialect: genAiDialect,
    attrs: (role) => ({
      'gen_ai.input.messages': JSON.stringify([
        { role, parts: [{ type: 'text', content: SECRET }] },
      ]),
    }),
  },
  gen_ai_legacy: {
    dialect: genAiLegacyDialect,
    attrs: (role) => ({
      'gen_ai.prompt.0.role': role,
      'gen_ai.prompt.0.content': SECRET,
    }),
  },
  openinference: {
    dialect: openinferenceDialect,
    attrs: (role) => ({
      'openinference.span.kind': 'LLM',
      'llm.input_messages.0.message.role': role,
      'llm.input_messages.0.message.content': SECRET,
    }),
  },
  openllmetry: {
    dialect: openllmetryDialect,
    attrs: (role) => ({
      'traceloop.span.kind': 'llm',
      'llm.prompts.0.role': role,
      'llm.prompts.0.content': SECRET,
    }),
  },
  vercel: {
    dialect: vercelDialect,
    attrs: (role) => ({
      'ai.operationId': 'ai.generateText.doGenerate',
      'ai.prompt.messages': JSON.stringify([{ role, content: SECRET }]),
    }),
  },
};

function run(c: Case, role: string) {
  const s = span(c.attrs(role));
  const diags: OtlpDiag[] = [];
  const messages = c.dialect.extractMessages(s, buildSpanTree([s]), (d) => diags.push(d));
  return { messages, diags };
}

describe.each(Object.entries(cases))('%s: unknown role diag', (_name, c) => {
  test("role 'narrator' yields a user turn and exactly one diag naming role and span", () => {
    const { messages, diags } = run(c, 'narrator');
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe('user');
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ code: 'unknown_role', level: 'warn' });
    expect(diags[0]?.detail).toContain('narrator');
    expect(diags[0]?.detail).toContain(SPAN_ID);
  });

  test('the diag never carries message content', () => {
    const { diags } = run(c, 'narrator');
    expect(JSON.stringify(diags)).not.toContain(SECRET);
  });

  test('a very long role is truncated in the diag', () => {
    const { diags } = run(c, 'r'.repeat(500));
    expect(diags).toHaveLength(1);
    expect((diags[0]?.detail ?? '').length).toBeLessThan(200);
  });

  test.each(['user', 'assistant', 'system', 'tool'])("known role '%s' yields no diag", (role) => {
    expect(run(c, role).diags).toEqual([]);
  });

  test('omitting the callback still maps the role', () => {
    const s = span(c.attrs('narrator'));
    expect(c.dialect.extractMessages(s, buildSpanTree([s]))[0]?.role).toBe('user');
  });
});
