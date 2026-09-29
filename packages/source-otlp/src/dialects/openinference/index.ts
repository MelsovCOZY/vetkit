// OpenInference dialect: the one DialectV1 (packages/source-otlp/src/normalize/
// dialect.ts) that maps the OpenInference semantic conventions. Detection order, token
// single-counting and completeness flags are cascade concerns owned by the normalize cascade — this
// module only ever reads its own attribute keys off one span (root ledger DECISION: no
// cross-dialect fallbacks inside a dialect).
//
// Attribute names pinned to SPEC_COMMIT below:
// https://github.com/Arize-ai/openinference/blob/7feb0c4ba2fd77cb76036712e21d06ff15a2be22/spec/semantic_conventions.md
// Phoenix converts gen_ai.* to OpenInference at ingest and OpenInference takes
// precedence — this module never reads gen_ai.* keys itself; that precedence belongs to the normalize cascade.

import {
  CEV_ERROR_CODES,
  safeParseJson,
  validateJson,
  type JsonSchema,
  type Message,
  type MessagePart,
} from '@vetkit/spec';
import type { AnyValue, OtlpResource, OtlpSpan } from '../../reader/index.ts';
import type { SpanTree } from '../../reader/tree.ts';
import type { DialectV1 } from '../../normalize/dialect.ts';

// RISK (bead notes): the conventions are unreleased (manifest gen-ai-dev/1.42.0-dev) and renames
// are queued in changelog.d. This pins the attribute table to one commit of
// spec/semantic_conventions.md so drift is a diff against a known revision, not a guess.
const SPEC_COMMIT = '7feb0c4ba2fd77cb76036712e21d06ff15a2be22';

const KIND = 'openinference.span.kind';
const TOKEN_PROMPT = 'llm.token_count.prompt';
const TOKEN_COMPLETION = 'llm.token_count.completion';
const INPUT_VALUE = 'input.value';
const INPUT_MIME = 'input.mime_type';
const OUTPUT_VALUE = 'output.value';
const OUTPUT_MIME = 'output.mime_type';
const TOOL_NAME = 'tool.name';
const INPUT_MESSAGES = 'llm.input_messages';
const OUTPUT_MESSAGES = 'llm.output_messages';

const VALID_ROLES: readonly Message['role'][] = ['user', 'assistant', 'system', 'tool'];

const MESSAGE_PART_SCHEMA: JsonSchema = {
  oneOf: [
    {
      type: 'object',
      properties: { type: { const: 'text' }, content: { type: 'string' } },
      required: ['type', 'content'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        type: { const: 'tool_call' },
        id: { type: 'string' },
        name: { type: 'string' },
        arguments: {},
      },
      required: ['type', 'name'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        type: { const: 'tool_call_response' },
        id: { type: 'string' },
        response: {},
      },
      required: ['type', 'response'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: { type: { const: 'parse_error' }, detail: { type: 'string' } },
      required: ['type', 'detail'],
      additionalProperties: false,
    },
  ],
};

// A message list, mirroring @vetkit/spec's generated Message/MessagePart shape (packages/spec/src/
// generated/trace.ts). Kept as a private copy scoped to this fallback parse, not a $ref into
// traceSchema (that schema's top level is NormalizedTrace, not Message[]).
const MESSAGE_LIST_SCHEMA: JsonSchema = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      role: { enum: ['user', 'assistant', 'system', 'tool'] },
      parts: { type: 'array', items: MESSAGE_PART_SCHEMA },
    },
    required: ['role', 'parts'],
    additionalProperties: false,
  },
};

// Unknown roles map to 'user' (Approach: "unknown roles map to 'user' with a diag warning
// event"). DialectV1.extractMessages has no diag output channel — only detectDialect's
// mixed_dialects warning does — so this mapping is silent here; a
// diag channel for per-message warnings is out of this bead's scope.
function isRole(value: string): value is Message['role'] {
  return (VALID_ROLES as readonly string[]).includes(value);
}

function mapRole(raw: AnyValue | undefined): Message['role'] {
  return typeof raw === 'string' && isRole(raw) ? raw : 'user';
}

function textContent(value: AnyValue): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

// Indices present under `${prefix}.<n>.message.` — not assumed contiguous, so a gap never hides
// a later index.
function messageIndices(attrs: Record<string, AnyValue>, prefix: string): number[] {
  const re = new RegExp(`^${prefix}\\.(\\d+)\\.message\\.`);
  const found = new Set<number>();
  for (const key of Object.keys(attrs)) {
    const match = re.exec(key);
    if (match?.[1] !== undefined) found.add(Number(match[1]));
  }
  return [...found].toSorted((a, b) => a - b);
}

function toolCallIndices(
  attrs: Record<string, AnyValue>,
  prefix: string,
  messageIndex: number,
): number[] {
  const re = new RegExp(
    `^${prefix}\\.${messageIndex}\\.message\\.tool_calls\\.(\\d+)\\.tool_call\\.`,
  );
  const found = new Set<number>();
  for (const key of Object.keys(attrs)) {
    const match = re.exec(key);
    if (match?.[1] !== undefined) found.add(Number(match[1]));
  }
  return [...found].toSorted((a, b) => a - b);
}

function toolCallParts(
  attrs: Record<string, AnyValue>,
  prefix: string,
  messageIndex: number,
): MessagePart[] {
  const parts: MessagePart[] = [];
  for (const toolCallIndex of toolCallIndices(attrs, prefix, messageIndex)) {
    const base = `${prefix}.${messageIndex}.message.tool_calls.${toolCallIndex}.tool_call`;
    const name = attrs[`${base}.function.name`];
    if (typeof name !== 'string') continue;
    const id = attrs[`${base}.id`];
    const args = attrs[`${base}.function.arguments`];
    parts.push({
      type: 'tool_call',
      ...(typeof id === 'string' ? { id } : {}),
      name,
      ...(args !== undefined ? { arguments: args } : {}),
    });
  }
  return parts;
}

// llm.input_messages / llm.output_messages: indexed message.role + message.content +
// message.tool_calls.*. Returns [] when no index is present under this prefix at all.
// message.tool_call_id marks this index as a tool turn responding to a call — its
// content becomes a tool_call_response part, never a sibling text part.
function indexedMessages(attrs: Record<string, AnyValue>, prefix: string): Message[] {
  return messageIndices(attrs, prefix).map((index) => {
    const role = mapRole(attrs[`${prefix}.${index}.message.role`]);
    const content = attrs[`${prefix}.${index}.message.content`];
    const toolCallId = attrs[`${prefix}.${index}.message.tool_call_id`];
    const parts: MessagePart[] = [];
    if (typeof toolCallId === 'string') {
      parts.push({
        type: 'tool_call_response',
        id: toolCallId,
        response: content !== undefined ? textContent(content) : '',
      });
    } else if (content !== undefined) {
      parts.push({ type: 'text', content: textContent(content) });
    }
    parts.push(...toolCallParts(attrs, prefix, index));
    return { role, parts };
  });
}

// Parses `raw` as a message list per MESSAGE_LIST_SCHEMA. `raw` is either the JSON-string form
// (safeParseJson's normal chokepoint use) or an already-structured AnyValue (arrived via
// kvlistValue/arrayValue flattening rather than a JSON string) — the Approach note "structured
// (non-string) attribute values are accepted as-is after schema validation" — validated directly
// through validateJson instead.
function parseMessageList(raw: AnyValue): ReturnType<typeof safeParseJson<Message[]>> {
  return typeof raw === 'string'
    ? safeParseJson<Message[]>(raw, MESSAGE_LIST_SCHEMA)
    : validateJson<Message[]>(raw, MESSAGE_LIST_SCHEMA);
}

// input.value/output.value fallback, used only when the indexed llm.<input|output>_messages.*
// attributes are absent for that direction (Scope: no cross-dialect fallback, but input.value and
// output.value are this dialect's own keys). text/plain (or no mime_type) becomes one message;
// application/json is parsed as a message list when it validates, else falls back to one text
// part — except JSON that fails to even parse, which becomes a parse_error part (Edge cases).
function fallbackMessages(
  attrs: Record<string, AnyValue>,
  valueKey: string,
  mimeKey: string,
  role: Message['role'],
): Message[] {
  const raw = attrs[valueKey];
  if (raw === undefined) return [];

  if (attrs[mimeKey] === 'application/json') {
    const parsed = parseMessageList(raw);
    if (parsed.ok) return parsed.value;
    if (typeof raw === 'string' && parsed.error.code === CEV_ERROR_CODES.E_JSON_PARSE) {
      return [{ role, parts: [{ type: 'parse_error', detail: parsed.error.message }] }];
    }
    return [{ role, parts: [{ type: 'text', content: textContent(raw) }] }];
  }

  return [{ role, parts: [{ type: 'text', content: textContent(raw) }] }];
}

// A TOOL-kind span: tool.name / input.value / output.value describe one tool invocation, not a
// chat turn — mapped as an assistant tool_call (the invocation) followed by a tool
// tool_call_response (the result), each only when its attribute is present.
function toolSpanMessages(attrs: Record<string, AnyValue>): Message[] {
  const messages: Message[] = [];
  const name = attrs[TOOL_NAME];
  if (typeof name === 'string') {
    const input = attrs[INPUT_VALUE];
    messages.push({
      role: 'assistant',
      parts: [{ type: 'tool_call', name, ...(input !== undefined ? { arguments: input } : {}) }],
    });
  }
  const output = attrs[OUTPUT_VALUE];
  if (output !== undefined) {
    messages.push({ role: 'tool', parts: [{ type: 'tool_call_response', response: output }] });
  }
  return messages;
}

// The mapping itself needs only span.attributes — SpanTree carries sibling/parent structure this
// dialect has no use for (its content lives entirely on the one span), but extractMessages keeps
// the (span, tree) shape DialectV1 requires; contentState reuses this same computation.
function messagesFor(span: OtlpSpan): Message[] {
  const attrs = span.attributes;
  if (attrs[KIND] === 'TOOL') return toolSpanMessages(attrs);

  const input = indexedMessages(attrs, INPUT_MESSAGES);
  const output = indexedMessages(attrs, OUTPUT_MESSAGES);
  const resolvedInput =
    input.length > 0 ? input : fallbackMessages(attrs, INPUT_VALUE, INPUT_MIME, 'user');
  const resolvedOutput =
    output.length > 0 ? output : fallbackMessages(attrs, OUTPUT_VALUE, OUTPUT_MIME, 'assistant');
  return [...resolvedInput, ...resolvedOutput];
}

function extractMessages(span: OtlpSpan, _tree: SpanTree): Message[] {
  return messagesFor(span);
}

function extractUsage(span: OtlpSpan): { inputTokens?: number; outputTokens?: number } | null {
  const prompt = span.attributes[TOKEN_PROMPT];
  const completion = span.attributes[TOKEN_COMPLETION];
  const inputTokens = typeof prompt === 'number' ? prompt : undefined;
  const outputTokens = typeof completion === 'number' ? completion : undefined;
  if (inputTokens === undefined && outputTokens === undefined) return null;
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
  };
}

// Spans whose mapped content attributes are entirely absent report 'not_captured', never an empty
// list masquerading as captured (acceptance criteria) — extractMessages already returns [] for
// exactly that case, for both LLM and TOOL spans, so contentState reuses it rather than
// duplicating the presence check. A malformed-JSON parse_error part still counts as captured
// content (Edge cases: "contentState 'captured' but the message list carries a parse_error part").
function contentState(span: OtlpSpan): 'captured' | 'not_captured' | 'redacted' {
  return messagesFor(span).length > 0 ? 'captured' : 'not_captured';
}

export const openinferenceDialect: DialectV1 = {
  name: 'openinference',
  specCommit: SPEC_COMMIT,
  detect: (span: OtlpSpan, _resource: OtlpResource) => Object.hasOwn(span.attributes, KIND),
  isLlmSpan: (span: OtlpSpan) => span.attributes[KIND] === 'LLM',
  extractMessages,
  extractUsage,
  contentState,
};
