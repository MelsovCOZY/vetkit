// vercelDialect: DialectV1 for the Vercel AI SDK's `ai.*` OTLP attribute
// convention. This module only answers per-span DialectV1 questions (detect, isLlmSpan,
// extractMessages, extractUsage, contentState); detection order, token single-counting and
// completeness flags are cascade concerns owned by the normalize cascade.
//
// Attribute map (AI SDK telemetry docs, span names, attributes, recordInputs/recordOutputs):
// https://github.com/vercel/ai/blob/main/content/docs/03-ai-sdk-core/60-telemetry.mdx
// The outer `ai.generateText`/`ai.streamText`/`ai.generateObject`/`ai.streamObject` span is
// kind 'other'; only its inner `.doGenerate`/`.doStream` provider span is an LLM span, so a
// duplicate ai.usage.* attribute copy on the outer span is never summed.
//
// RISK (bead notes): the GenAI semconv conventions this maps against are unreleased
// (gen-ai-dev/1.42.0-dev) and renames are queued in changelog.d; SPEC_COMMIT pins the doc
// revision this module was written against and is surfaced as NormalizedTrace.dialectVersion.

import { safeParseJson, type JsonSchema, type Message, type MessagePart } from '@vetkit/spec';
import type { OtlpSpan } from '../../reader/index.ts';
import type { DialectV1 } from '../../normalize/dialect.ts';

const SPEC_COMMIT = 'vercel/ai content/docs/03-ai-sdk-core/60-telemetry.mdx @ 2026-09-25';

// The inner provider spans (ai.generateText.doGenerate / ai.streamText.doStream /
// ai.generateObject.doGenerate / ai.streamObject.doStream). The outer ai.generateText etc.
// span and the ai.toolCall / evaluate {modelId} spans never appear here.
const INNER_OPERATION_IDS = new Set<string>([
  'ai.generateText.doGenerate',
  'ai.streamText.doStream',
  'ai.generateObject.doGenerate',
  'ai.streamObject.doStream',
]);

// Vercel's own wire shape for ai.prompt.messages: {role, content} where content is a plain
// string or an array of content parts (only `{type:'text', text}` parts are read; other part
// types are out of scope for this bead). Distinct from @vetkit/spec's Message/MessagePart.
const promptMessagesSchema: JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'array',
  items: {
    type: 'object',
    properties: {
      role: { type: 'string' },
      content: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'object' } }] },
    },
    required: ['role', 'content'],
  },
};

const toolCallsSchema: JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'array',
  items: {
    type: 'object',
    properties: {
      toolCallId: { type: 'string' },
      toolName: { type: 'string' },
      args: {},
    },
    required: ['toolName'],
  },
};

interface WirePromptMessage {
  role: unknown;
  content: unknown;
}

interface WireToolCall {
  toolCallId?: string;
  toolName: string;
  args?: unknown;
}

function stringAttr(span: OtlpSpan, key: string): string | undefined {
  const value = span.attributes[key];
  return typeof value === 'string' ? value : undefined;
}

function numberAttr(span: OtlpSpan, key: string): number | undefined {
  const value = span.attributes[key];
  return typeof value === 'number' ? value : undefined;
}

function toRole(raw: unknown): Message['role'] {
  return raw === 'system' || raw === 'assistant' || raw === 'tool' ? raw : 'user';
}

// A content-parts array entry's text, when it is a `{type:'text', text}` part; other Vercel
// content part types (image, file, ...) are out of scope for this bead and are skipped.
function textPartText(item: unknown): string | undefined {
  if (item === null || typeof item !== 'object') return undefined;
  if (!('type' in item) || !('text' in item)) return undefined;
  const { type, text } = item;
  return type === 'text' && typeof text === 'string' ? text : undefined;
}

// a `{type:'tool-call', toolCallId, toolName, args}` or `{type:'tool-result',
// toolCallId, toolName, result}` content-parts entry — the AI SDK's own wire shape for a prior
// assistant tool call or its tool response fed back on a later turn's ai.prompt.messages.
function toolCallContentPart(item: unknown): MessagePart | undefined {
  if (item === null || typeof item !== 'object' || !('type' in item)) return undefined;
  const toolCallId = 'toolCallId' in item ? item.toolCallId : undefined;
  const id = typeof toolCallId === 'string' ? { id: toolCallId } : {};
  if (item.type === 'tool-call') {
    const toolName = 'toolName' in item ? item.toolName : undefined;
    if (typeof toolName !== 'string') return undefined;
    const args = 'args' in item ? item.args : undefined;
    return {
      type: 'tool_call',
      ...id,
      name: toolName,
      ...(args === undefined ? {} : { arguments: args }),
    };
  }
  if (item.type === 'tool-result') {
    const result = 'result' in item ? item.result : undefined;
    return { type: 'tool_call_response', ...id, response: result };
  }
  return undefined;
}

// `{type:'text', text}` parts and `{type:'tool-call'|'tool-result', ...}` parts are read from a
// content-parts array; any other part type is skipped.
function contentToParts(content: unknown): MessagePart[] {
  if (typeof content === 'string') return [{ type: 'text', content }];
  if (!Array.isArray(content)) return [];
  const items: unknown[] = content;
  const parts: MessagePart[] = [];
  for (const item of items) {
    const text = textPartText(item);
    if (text !== undefined) {
      parts.push({ type: 'text', content: text });
      continue;
    }
    const toolPart = toolCallContentPart(item);
    if (toolPart !== undefined) parts.push(toolPart);
  }
  return parts;
}

// ai.prompt.messages wins over ai.prompt when both are present (real Vercel traces never emit
// both for the same span); undefined means the attribute itself was absent.
function messagesFromPrompt(span: OtlpSpan): Message[] {
  const rawMessages = stringAttr(span, 'ai.prompt.messages');
  if (rawMessages !== undefined) {
    const parsed = safeParseJson<WirePromptMessage[]>(rawMessages, promptMessagesSchema);
    if (!parsed.ok) {
      return [
        {
          role: 'user',
          parts: [{ type: 'parse_error', detail: 'ai.prompt.messages: invalid JSON' }],
        },
      ];
    }
    return parsed.value.map((m) => ({ role: toRole(m.role), parts: contentToParts(m.content) }));
  }

  const plainPrompt = stringAttr(span, 'ai.prompt');
  if (plainPrompt !== undefined) {
    return [{ role: 'user', parts: [{ type: 'text', content: plainPrompt }] }];
  }

  return [];
}

function responseParts(span: OtlpSpan): MessagePart[] {
  const parts: MessagePart[] = [];

  const text = stringAttr(span, 'ai.response.text');
  if (text !== undefined) parts.push({ type: 'text', content: text });

  // Structured output (generateObject/streamObject): one text part carrying the raw JSON,
  // not re-parsed into an object.
  const objectText = stringAttr(span, 'ai.response.object');
  if (objectText !== undefined) parts.push({ type: 'text', content: objectText });

  const rawToolCalls = stringAttr(span, 'ai.response.toolCalls');
  if (rawToolCalls !== undefined) {
    const parsed = safeParseJson<WireToolCall[]>(rawToolCalls, toolCallsSchema);
    if (parsed.ok) {
      for (const call of parsed.value) {
        parts.push({
          type: 'tool_call',
          ...(call.toolCallId === undefined ? {} : { id: call.toolCallId }),
          name: call.toolName,
          ...(call.args === undefined ? {} : { arguments: call.args }),
        });
      }
    } else {
      parts.push({ type: 'parse_error', detail: 'ai.response.toolCalls: invalid JSON' });
    }
  }

  return parts;
}

function hasContentAttribute(span: OtlpSpan): boolean {
  return (
    span.attributes['ai.prompt.messages'] !== undefined ||
    span.attributes['ai.prompt'] !== undefined ||
    span.attributes['ai.response.text'] !== undefined ||
    span.attributes['ai.response.toolCalls'] !== undefined ||
    span.attributes['ai.response.object'] !== undefined
  );
}

export const vercelDialect: DialectV1 = {
  name: 'vercel',
  specCommit: SPEC_COMMIT,

  detect: (span) =>
    span.attributes['ai.operationId'] !== undefined ||
    span.attributes['ai.model.id'] !== undefined ||
    span.attributes['ai.prompt.messages'] !== undefined,

  isLlmSpan: (span) => {
    const operationId = stringAttr(span, 'ai.operationId');
    return operationId !== undefined && INNER_OPERATION_IDS.has(operationId);
  },

  extractMessages: (span) => {
    const messages = messagesFromPrompt(span);
    const parts = responseParts(span);
    if (parts.length > 0) messages.push({ role: 'assistant', parts });
    return messages;
  },

  extractUsage: (span) => {
    // v5+ renamed promptTokens/completionTokens to inputTokens/outputTokens; whichever
    // vocabulary is present is read, never both.
    const inputTokens =
      numberAttr(span, 'ai.usage.promptTokens') ?? numberAttr(span, 'ai.usage.inputTokens');
    const outputTokens =
      numberAttr(span, 'ai.usage.completionTokens') ?? numberAttr(span, 'ai.usage.outputTokens');
    if (inputTokens === undefined && outputTokens === undefined) return null;
    return {
      ...(inputTokens === undefined ? {} : { inputTokens }),
      ...(outputTokens === undefined ? {} : { outputTokens }),
    };
  },

  contentState: (span) => (hasContentAttribute(span) ? 'captured' : 'not_captured'),
};
