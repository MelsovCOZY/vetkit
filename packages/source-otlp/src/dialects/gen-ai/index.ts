// gen_ai dialect (bead mol-pij.3): two DialectV1 objects (packages/source-otlp/src/normalize/
// dialect.ts, owned by pij.2) for the OTel GenAI semantic conventions —
//   genAiDialect       (name: 'gen_ai')        the latest attribute-based convention
//   genAiLegacyDialect (name: 'gen_ai_legacy')  the deprecated indexed/event-based convention
// Detection order, token single-counting and completeness flags are cascade concerns owned by
// pij.2/pij.7/pij.11; this module only ever answers questions about one span, and each dialect
// reads only its own attribute keys — never the other's (no cross-dialect fallback).
//
// PREMISE (web, raw doc fetched 2026-09-25, gen-ai-events.md;
// https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md).
// The manifest at that commit is unreleased/Development (`gen-ai-dev/1.42.0-dev`), so the
// attribute table is pinned here rather than to a tagged release (ET brief §2.4, root RISK).

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

// Shared by both dialects (root acceptance criteria): operation.name in the LLM set, or — when
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

// -- JSON-string / structured attribute parsing -----------------------------------------------
//
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

// A part kind this repo's MessagePart union does not carry (packages/spec/schemas/
// trace.schema.json $defs.MessagePart: text | tool_call | tool_call_response | parse_error —
// no 'reasoning', unlike the upstream semconv draft) is downgraded to a text part rather than
// dropped or thrown on. See BUILD report Deviations.
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

function messagesFromRaw(raw: readonly RawMessage[], fallbackRole: Message['role']): Message[] {
  return raw.map((m) => ({ role: mapRole(m.role, fallbackRole), parts: m.parts.map(mapPart) }));
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
    return parsed.ok
      ? [{ role: 'system', parts: parsed.value.map(mapPart) }]
      : parseErrorMessage('system', parsed.error.message);
  }
  const validated = validateJson<RawPart[]>(value, RAW_PARTS_ARRAY_SCHEMA);
  return validated.ok
    ? [{ role: 'system', parts: validated.value.map(mapPart) }]
    : parseErrorMessage('system', validated.error.message);
}

// -- genAiDialect (latest) ----------------------------------------------------------------------

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
// the full latest attribute table even though the default cascade (pij.11) never calls it here.
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

// -- genAiLegacyDialect ---------------------------------------------------------------------------

const LEGACY_INDEX_RE = /^gen_ai\.(prompt|completion)\.(\d+)\.(role|content)$/;
const LEGACY_EVENT_NAMES = new Set(['gen_ai.content.prompt', 'gen_ai.content.completion']);

function hasLegacyIndexedAttrs(span: OtlpSpan): boolean {
  return Object.keys(span.attributes).some((key) => LEGACY_INDEX_RE.test(key));
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

interface LegacyIndexedEntry {
  role?: string;
  content?: string;
}

function legacyIndexedMessages(
  span: OtlpSpan,
  group: 'prompt' | 'completion',
  fallbackRole: Message['role'],
): Message[] {
  const byIndex = new Map<number, LegacyIndexedEntry>();
  for (const [key, value] of Object.entries(span.attributes)) {
    const match = LEGACY_INDEX_RE.exec(key);
    if (match === null || match[1] !== group) continue;
    const idx = Number(match[2]);
    const entry = byIndex.get(idx) ?? {};
    if (match[3] === 'role' && typeof value === 'string') entry.role = value;
    if (match[3] === 'content' && typeof value === 'string') entry.content = value;
    byIndex.set(idx, entry);
  }
  return [...byIndex.entries()]
    .toSorted(([a], [b]) => a - b)
    .map(([, entry]) => ({
      role: mapRole(entry.role, fallbackRole),
      parts: [{ type: 'text', content: entry.content ?? '' }],
    }));
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
// body under gen_ai.prompt / gen_ai.completion respectively (PREMISE gen-ai-events.md).
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
