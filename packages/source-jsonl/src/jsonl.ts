// Line parsing and mapping for the two accepted JSONL shapes:
// - own export: {traceId, messages: Message[], spans?} validated against trace.schema.json with
//   only traceId + messages required;
// - OpenAI-style: {id?, messages: [{role, content, tool_calls?, tool_call_id?}]}.
// Any other shape is rejected; the caller turns the rejection into a TRACE_INVALID diag.

import { createHash } from 'node:crypto';
import {
  safeParseJson,
  traceSchema,
  validateJson,
  type JsonSchema,
  type Message,
  type MessagePart,
  type NormalizedTrace,
} from '@vetkit/spec';

const COMPLETENESS = { contentCaptured: true, truncated: false, missingParents: false } as const;

// A distinct $id: ajv registers compiled schemas by id, so reusing trace.schema.json's would clash.
const ownLineSchema: JsonSchema = {
  ...traceSchema,
  $id: 'https://melsovcozy.github.io/vetkit/schemas/source-jsonl/own-line.schema.json',
  title: 'JsonlOwnLine',
  required: ['traceId', 'messages'],
};

const openAiTextPart: JsonSchema = {
  type: 'object',
  properties: { type: { const: 'text' }, text: { type: 'string' } },
  required: ['type', 'text'],
};

const openAiLineSchema: JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://melsovcozy.github.io/vetkit/schemas/source-jsonl/openai-line.schema.json',
  type: 'object',
  properties: {
    id: { type: 'string' },
    messages: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          role: { enum: ['system', 'developer', 'user', 'assistant', 'tool'] },
          content: {
            anyOf: [{ type: 'string' }, { type: 'null' }, { type: 'array', items: openAiTextPart }],
          },
          tool_call_id: { type: 'string' },
          tool_calls: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                function: {
                  type: 'object',
                  properties: { name: { type: 'string' }, arguments: { type: 'string' } },
                  required: ['name'],
                },
              },
              required: ['function'],
            },
          },
        },
        required: ['role'],
      },
    },
  },
  required: ['messages'],
};

const anyJson: JsonSchema = {};

interface OwnLine {
  traceId: string;
  messages: Message[];
  spans?: NormalizedTrace['spans'];
  tokens?: NormalizedTrace['tokens'];
}

interface OpenAiMessage {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool';
  content?: string | null | Array<{ type: 'text'; text: string }>;
  tool_call_id?: string;
  tool_calls?: Array<{ id?: string; function: { name: string; arguments?: string } }>;
}

interface OpenAiLine {
  id?: string;
  messages: OpenAiMessage[];
}

export type LineResult = { ok: true; trace: NormalizedTrace } | { ok: false; reason: string };

function contentText(content: OpenAiMessage['content']): string[] {
  if (typeof content === 'string') return [content];
  if (Array.isArray(content)) return content.map((part) => part.text);
  return [];
}

function mapOpenAiMessage(message: OpenAiMessage): Message {
  const texts = contentText(message.content);
  if (message.role === 'tool') {
    const response: MessagePart = { type: 'tool_call_response', response: texts.join('') };
    if (message.tool_call_id !== undefined) response.id = message.tool_call_id;
    return { role: 'tool', parts: [response] };
  }
  const parts: MessagePart[] = texts.map((content) => ({ type: 'text', content }));
  for (const call of message.tool_calls ?? []) {
    const part: MessagePart = { type: 'tool_call', name: call.function.name };
    if (call.id !== undefined) part.id = call.id;
    if (call.function.arguments !== undefined) part.arguments = call.function.arguments;
    parts.push(part);
  }
  return { role: message.role === 'developer' ? 'system' : message.role, parts };
}

function mapOwn(line: OwnLine): NormalizedTrace {
  const trace: NormalizedTrace = {
    traceId: line.traceId,
    spans: line.spans ?? [],
    messages: line.messages,
    dialect: 'jsonl-own',
    completeness: { ...COMPLETENESS },
  };
  if (line.tokens !== undefined) trace.tokens = line.tokens;
  return trace;
}

function mapOpenAi(line: OpenAiLine, raw: string): NormalizedTrace {
  return {
    traceId: line.id ?? createHash('sha256').update(raw).digest('hex'),
    spans: [],
    messages: line.messages.map(mapOpenAiMessage),
    dialect: 'jsonl-openai',
    completeness: { ...COMPLETENESS },
  };
}

/** Parses one non-empty JSONL line into a NormalizedTrace, or a reason it was rejected. */
export function parseLine(raw: string): LineResult {
  const parsed = safeParseJson<unknown>(raw, anyJson);
  if (!parsed.ok) return { ok: false, reason: 'invalid JSON' };

  const own = validateJson<OwnLine>(parsed.value, ownLineSchema);
  if (own.ok) return { ok: true, trace: mapOwn(own.value) };

  const openAi = validateJson<OpenAiLine>(parsed.value, openAiLineSchema);
  if (openAi.ok) return { ok: true, trace: mapOpenAi(openAi.value, raw) };

  return {
    ok: false,
    reason:
      'unrecognised line shape; expected {traceId, messages, spans?} or ' +
      '{id?, messages: [{role, content}]}',
  };
}
