// gen_ai dialect: two DialectV1 objects (../../normalize/dialect.ts)
// for the OTel GenAI semantic conventions —
//   genAiDialect       (name: 'gen_ai')        the latest attribute-based convention
//   genAiLegacyDialect (name: 'gen_ai_legacy')  the deprecated indexed/event-based convention
// Detection order, token single-counting and completeness flags are cascade concerns owned by
// the normalize cascade; this module only ever answers questions about one span, and each dialect
// reads only its own attribute keys — never the other's (no cross-dialect fallback).
//
// The attribute table was read from the raw docs (gen-ai-events.md;
// https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md)
// fetched 2026-09-25. The manifest at that commit is unreleased/Development
// (`gen-ai-dev/1.42.0-dev`), so the table is pinned here rather than to a tagged release (the
// attribute names may still change).

import type { Message, MessagePart } from '@vetkit/spec';
import { safeParseJson, validateJson, type JsonSchema } from '@vetkit/spec';
import type { DialectV1 } from '../../normalize/dialect.ts';
import type { AnyValue, OtlpSpan } from '../../reader/index.ts';

const SPEC_COMMIT = 'gen-ai-dev/1.42.0-dev';

const LLM_OPERATIONS = ['chat', 'text_completion', 'generate_content'] as const;
const KNOWN_ROLES: Record<string, Message['role']> = {
  user: 'user',
  assistant: 'assistant',
  system: 'system',
  tool: 'tool',
};

function operationName(span: OtlpSpan): string | undefined {
  const value = span.attributes['gen_ai.operation.name'];
  return typeof value === 'string' ? value : undefined;
}

// Shared by both dialects: operation.name in the LLM set, or — when
// operation.name is absent — the span name starts with one of those operation names
// (instrumentations commonly name spans "{operation_name} {model}"). An operation.name that is
// present but outside the set (e.g. execute_tool, embeddings) is authoritative and decides the
// span is not an LLM span regardless of its name.
function isLlmSpan(span: OtlpSpan): boolean {
  const op = operationName(span);
  if (op !== undefined) return (LLM_OPERATIONS as readonly string[]).includes(op);
  return LLM_OPERATIONS.some((prefix) => span.name.startsWith(prefix));
}

function mapRole(role: unknown, fallback: Message['role']): Message['role'] {
  if (typeof role !== 'string') return fallback;
  return KNOWN_ROLES[role] ?? fallback;
}

// gen_ai.input.messages / output.messages / system_instructions arrive either as a JSON string
// (parse through the safeParseJson chokepoint) or already structured (an OTLP arrayValue is
// flattened to a real array by the reader, validated with the same schema via validateJson).
// The schemas below are intentionally permissive on unknown MessagePart kinds — see mapPart.

interface RawPart {
  type: string;
  content?: unknown;
  text?: unknown;
  id?: unknown;
  name?: unknown;
  arguments?: unknown;
  response?: unknown;
  result?: unknown;
}
interface RawMessage {
  role?: unknown;
  parts: RawPart[];
}

const RAW_PART_SCHEMA: JsonSchema = {
  type: 'object',
  properties: { type: { type: 'string' } },
  required: ['type'],
  additionalProperties: true,
};

const RAW_MESSAGES_SCHEMA: JsonSchema = {
  type: 'array',
  items: {
    type: 'object',
    properties: { role: {}, parts: { type: 'array', items: RAW_PART_SCHEMA } },
    required: ['parts'],
    additionalProperties: true,
  },
};

// system_instructions is an array of parts directly (the role is implicitly 'system'), not an
// array of {role, parts} messages.
const RAW_PARTS_ARRAY_SCHEMA: JsonSchema = { type: 'array', items: RAW_PART_SCHEMA };

// Design choice: the trace IR MessagePart set is text{content} / tool_call /
// tool_call_response{id?,response} / parse_error{detail} — no 'reasoning' variant, unlike the
// upstream semconv draft, and reasoning parts are DROPPED (never downgraded to text). Any other
// unmapped part kind (not in the semconv table at all) still downgrades to a text part rather
// than being dropped or thrown on, so unrecognised-but-real content is never silently lost.
function mapPart(raw: RawPart): MessagePart {
  switch (raw.type) {
    case 'text':
      return { type: 'text', content: typeof raw.content === 'string' ? raw.content : '' };
    case 'tool_call': {
      const id = typeof raw.id === 'string' ? raw.id : undefined;
      return {
        type: 'tool_call',
        name: typeof raw.name === 'string' ? raw.name : '',
        ...(id === undefined ? {} : { id }),
        ...('arguments' in raw ? { arguments: raw.arguments } : {}),
      };
    }
    case 'tool_call_response': {
      const id = typeof raw.id === 'string' ? raw.id : undefined;
      const response = 'response' in raw ? raw.response : raw.result;
      return { type: 'tool_call_response', ...(id === undefined ? {} : { id }), response };
    }
    default: {
      const content = typeof raw.content === 'string' ? raw.content : raw.text;
      return { type: 'text', content: typeof content === 'string' ? content : '' };
    }
  }
}

// Drops reasoning parts before mapping; every other kind (known or unmapped) passes through.
function mapParts(raw: readonly RawPart[]): MessagePart[] {
  return raw.filter((part) => part.type !== 'reasoning').map(mapPart);
}

// A message left with zero parts after dropping its reasoning content carries nothing, so it is
// omitted entirely rather than kept as an empty-parts message.
function messagesFromRaw(raw: readonly RawMessage[], fallbackRole: Message['role']): Message[] {
  return raw
    .map((m) => ({ role: mapRole(m.role, fallbackRole), parts: mapParts(m.parts) }))
    .filter((m) => m.parts.length > 0);
}

function parseErrorMessage(role: Message['role'], detail: string): Message[] {
  return [{ role, parts: [{ type: 'parse_error', detail }] }];
}

function parseMessagesAttr(value: AnyValue | undefined, fallbackRole: Message['role']): Message[] {
  if (value === undefined) return [];
  if (typeof value === 'string') {
    const parsed = safeParseJson<RawMessage[]>(value, RAW_MESSAGES_SCHEMA);
    return parsed.ok
      ? messagesFromRaw(parsed.value, fallbackRole)
      : parseErrorMessage(fallbackRole, parsed.error.message);
  }
  const validated = validateJson<RawMessage[]>(value, RAW_MESSAGES_SCHEMA);
  return validated.ok
    ? messagesFromRaw(validated.value, fallbackRole)
    : parseErrorMessage(fallbackRole, validated.error.message);
}

function parseSystemInstructions(value: AnyValue | undefined): Message[] {
  if (value === undefined) return [];
  if (typeof value === 'string') {
    const parsed = safeParseJson<RawPart[]>(value, RAW_PARTS_ARRAY_SCHEMA);
    if (!parsed.ok) return parseErrorMessage('system', parsed.error.message);
    const parts = mapParts(parsed.value);
    return parts.length > 0 ? [{ role: 'system', parts }] : [];
  }
  const validated = validateJson<RawPart[]>(value, RAW_PARTS_ARRAY_SCHEMA);
  if (!validated.ok) return parseErrorMessage('system', validated.error.message);
  const parts = mapParts(validated.value);
  return parts.length > 0 ? [{ role: 'system', parts }] : [];
}

const LATEST_CONTENT_KEYS = [
  'gen_ai.input.messages',
  'gen_ai.output.messages',
  'gen_ai.system_instructions',
] as const;

function hasAny(span: OtlpSpan, keys: readonly string[]): boolean {
  return keys.some((key) => span.attributes[key] !== undefined);
}

function detectLatest(span: OtlpSpan): boolean {
  return operationName(span) !== undefined && hasAny(span, LATEST_CONTENT_KEYS);
}

function contentStateLatest(span: OtlpSpan): 'captured' | 'not_captured' | 'redacted' {
  return hasAny(span, LATEST_CONTENT_KEYS) ? 'captured' : 'not_captured';
}

// execute_tool spans (never isLlmSpan) carry the call's arguments/result as flat attributes
// instead of gen_ai.{input,output}.messages. Read directly so extractMessages stays faithful to
// the full latest attribute table even though the default cascade never calls it here.
function toolCallMessages(span: OtlpSpan): Message[] {
  const args = span.attributes['gen_ai.tool.call.arguments'];
  const result = span.attributes['gen_ai.tool.call.result'];
  if (args === undefined && result === undefined) return [];
  const name = span.attributes['gen_ai.tool.name'];
  const id = span.attributes['gen_ai.tool.call.id'];
  const idProp = typeof id === 'string' ? { id } : {};
  const parts: MessagePart[] = [];
  if (args !== undefined) {
    parts.push({
      type: 'tool_call',
      name: typeof name === 'string' ? name : '',
      ...idProp,
      arguments: args,
    });
  }
  if (result !== undefined) {
    parts.push({ type: 'tool_call_response', ...idProp, response: result });
  }
  return [{ role: 'tool', parts }];
}

function extractMessagesLatest(span: OtlpSpan): Message[] {
  const messages = [
    ...parseSystemInstructions(span.attributes['gen_ai.system_instructions']),
    ...parseMessagesAttr(span.attributes['gen_ai.input.messages'], 'user'),
    ...parseMessagesAttr(span.attributes['gen_ai.output.messages'], 'assistant'),
  ];
  return messages.length > 0 ? messages : toolCallMessages(span);
}

function numberAttr(span: OtlpSpan, key: string): number | undefined {
  const value = span.attributes[key];
  return typeof value === 'number' ? value : undefined;
}

// Reads only the latest gen_ai.usage.* keys. A span that also carries legacy prompt_tokens/
// completion_tokens is never consulted here — that is the "never sum both" rule, kept true by
// each dialect touching only its own keys. Anything else under gen_ai.usage.* (cache tokens,
// etc.) is silently ignored, never thrown on.
function extractUsageLatest(
  span: OtlpSpan,
): { inputTokens?: number; outputTokens?: number } | null {
  const inputTokens = numberAttr(span, 'gen_ai.usage.input_tokens');
  const outputTokens = numberAttr(span, 'gen_ai.usage.output_tokens');
  if (inputTokens === undefined && outputTokens === undefined) return null;
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
  };
}

export const genAiDialect: DialectV1 = {
  name: 'gen_ai',
  specCommit: SPEC_COMMIT,
  detect: (span) => detectLatest(span),
  isLlmSpan,
  extractMessages: (span) => extractMessagesLatest(span),
  extractUsage: extractUsageLatest,
  contentState: contentStateLatest,
};

const LEGACY_INDEX_RE = /^gen_ai\.(prompt|completion)\.(\d+)\.(role|content|tool_call_id)$/;
// gen_ai.{prompt,completion}.{n}.tool_calls.{i}.{id,name,arguments} — an assistant turn's
// own tool call(s), indexed the same way llm.output_messages.*.message.tool_calls is in the
// OpenInference dialect (no cross-dialect import; the pattern is only coincidentally similar).
const LEGACY_TOOL_CALL_RE =
  /^gen_ai\.(prompt|completion)\.(\d+)\.tool_calls\.(\d+)\.(id|name|arguments)$/;
const LEGACY_EVENT_NAMES = new Set(['gen_ai.content.prompt', 'gen_ai.content.completion']);

function hasLegacyIndexedAttrs(span: OtlpSpan): boolean {
  return Object.keys(span.attributes).some(
    (key) => LEGACY_INDEX_RE.test(key) || LEGACY_TOOL_CALL_RE.test(key),
  );
}

function hasLegacyContentEvents(span: OtlpSpan): boolean {
  return span.events.some((event) => LEGACY_EVENT_NAMES.has(event.name));
}

function detectLegacy(span: OtlpSpan): boolean {
  return (
    operationName(span) !== undefined &&
    (hasLegacyIndexedAttrs(span) || hasLegacyContentEvents(span))
  );
}

function contentStateLegacy(span: OtlpSpan): 'captured' | 'not_captured' | 'redacted' {
  return hasLegacyIndexedAttrs(span) || hasLegacyContentEvents(span) ? 'captured' : 'not_captured';
}

interface LegacyToolCall {
  id?: string;
  name?: string;
  arguments?: AnyValue;
}

interface LegacyIndexedEntry {
  role?: string;
  content?: string;
  toolCallId?: string;
  toolCalls: Map<number, LegacyToolCall>;
}

function legacyIndexedMessages(
  span: OtlpSpan,
  group: 'prompt' | 'completion',
  fallbackRole: Message['role'],
): Message[] {
  const byIndex = new Map<number, LegacyIndexedEntry>();
  const entryFor = (idx: number): LegacyIndexedEntry => {
    let entry = byIndex.get(idx);
    if (entry === undefined) {
      entry = { toolCalls: new Map() };
      byIndex.set(idx, entry);
    }
    return entry;
  };
  for (const [key, value] of Object.entries(span.attributes)) {
    const match = LEGACY_INDEX_RE.exec(key);
    if (match !== null && match[1] === group) {
      const entry = entryFor(Number(match[2]));
      if (match[3] === 'role' && typeof value === 'string') entry.role = value;
      if (match[3] === 'content' && typeof value === 'string') entry.content = value;
      if (match[3] === 'tool_call_id' && typeof value === 'string') entry.toolCallId = value;
      continue;
    }
    const toolMatch = LEGACY_TOOL_CALL_RE.exec(key);
    if (toolMatch !== null && toolMatch[1] === group) {
      const entry = entryFor(Number(toolMatch[2]));
      const callIdx = Number(toolMatch[3]);
      const call = entry.toolCalls.get(callIdx) ?? {};
      if (toolMatch[4] === 'id' && typeof value === 'string') call.id = value;
      if (toolMatch[4] === 'name' && typeof value === 'string') call.name = value;
      if (toolMatch[4] === 'arguments') call.arguments = value;
      entry.toolCalls.set(callIdx, call);
    }
  }
  return [...byIndex.entries()]
    .toSorted(([a], [b]) => a - b)
    .map(([, entry]) => {
      const parts: MessagePart[] = [];
      // A tool_call_id marks this entry as a tool turn responding to a call; its content is the
      // response, never a sibling text part (never `entry.content ?? ''` duplicated as text).
      if (entry.toolCallId !== undefined) {
        parts.push({
          type: 'tool_call_response',
          id: entry.toolCallId,
          response: entry.content ?? '',
        });
      } else {
        parts.push({ type: 'text', content: entry.content ?? '' });
      }
      for (const [, call] of [...entry.toolCalls.entries()].toSorted(([a], [b]) => a - b)) {
        if (call.name === undefined) continue;
        parts.push({
          type: 'tool_call',
          ...(call.id === undefined ? {} : { id: call.id }),
          name: call.name,
          ...(call.arguments === undefined ? {} : { arguments: call.arguments }),
        });
      }
      return { role: mapRole(entry.role, fallbackRole), parts };
    });
}

interface RawLegacyEntry {
  role?: unknown;
  content?: unknown;
}

const RAW_LEGACY_ARRAY_SCHEMA: JsonSchema = {
  type: 'array',
  items: {
    type: 'object',
    properties: { role: { type: 'string' }, content: { type: 'string' } },
    additionalProperties: true,
  },
};

function legacyEventBody(value: AnyValue | undefined, fallbackRole: Message['role']): Message[] {
  if (value === undefined) return [];
  const result =
    typeof value === 'string'
      ? safeParseJson<RawLegacyEntry[]>(value, RAW_LEGACY_ARRAY_SCHEMA)
      : validateJson<RawLegacyEntry[]>(value, RAW_LEGACY_ARRAY_SCHEMA);
  if (!result.ok) return parseErrorMessage(fallbackRole, result.error.message);
  return result.value.map((entry) => ({
    role: mapRole(entry.role, fallbackRole),
    parts: [{ type: 'text', content: typeof entry.content === 'string' ? entry.content : '' }],
  }));
}

// gen_ai.content.prompt / gen_ai.content.completion span events carry the messages as a JSON
// body under gen_ai.prompt / gen_ai.completion respectively (see gen-ai-events.md).
function legacyEventMessages(span: OtlpSpan): Message[] {
  const messages: Message[] = [];
  for (const event of span.events) {
    if (event.name === 'gen_ai.content.prompt') {
      messages.push(...legacyEventBody(event.attributes['gen_ai.prompt'], 'user'));
    } else if (event.name === 'gen_ai.content.completion') {
      messages.push(...legacyEventBody(event.attributes['gen_ai.completion'], 'assistant'));
    }
  }
  return messages;
}

function extractMessagesLegacy(span: OtlpSpan): Message[] {
  const indexed = [
    ...legacyIndexedMessages(span, 'prompt', 'user'),
    ...legacyIndexedMessages(span, 'completion', 'assistant'),
  ];
  return indexed.length > 0 ? indexed : legacyEventMessages(span);
}

// Reads only the legacy gen_ai.usage.{prompt,completion}_tokens keys — never the latest
// input_tokens/output_tokens, which is what keeps a span carrying both from being summed twice.
function extractUsageLegacy(
  span: OtlpSpan,
): { inputTokens?: number; outputTokens?: number } | null {
  const inputTokens = numberAttr(span, 'gen_ai.usage.prompt_tokens');
  const outputTokens = numberAttr(span, 'gen_ai.usage.completion_tokens');
  if (inputTokens === undefined && outputTokens === undefined) return null;
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
  };
}

export const genAiLegacyDialect: DialectV1 = {
  name: 'gen_ai_legacy',
  specCommit: SPEC_COMMIT,
  detect: (span) => detectLegacy(span),
  isLlmSpan,
  extractMessages: (span) => extractMessagesLegacy(span),
  extractUsage: extractUsageLegacy,
  contentState: contentStateLegacy,
};
