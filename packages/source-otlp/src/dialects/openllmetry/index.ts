// OpenLLMetry (traceloop) dialect (bead mol-pij.5): maps the legacy indexed llm.prompts.{n}/
// llm.completions.{n} attributes, the gen_ai.prompt.{n}/gen_ai.completion.{n} legacy form that
// traceloop's genainormalizerprocessor also emits, and the JSON-string traceloop.entity.input/
// traceloop.entity.output attributes on workflow/task spans, onto Message[]/usage per DialectV1
// (mol-pij.2). Detection order, cross-span token summation and completeness flags belong to
// pij.2/pij.7; this module only ever answers questions about one span, and never reads another
// dialect's keys (contract pij.5 scope — no cross-dialect fallbacks).
//
// The indexed-attribute reader below is intentionally duplicated per dialect (contract pij.5
// note: "read via the shared indexed-attribute helper duplicated locally — no cross-dialect
// import"), rather than imported from a sibling dialects/* module.

import {
  safeParseJson,
  validateJson,
  traceSchema,
  type JsonSchema,
  type Message,
  type MessagePart,
} from '@vetkit/spec';
import type { AnyValue, OtlpSpan } from '../../reader/index.ts';
import type { DialectV1 } from '../../normalize/dialect.ts';

// The conventions this table was mapped from are unreleased (gen-ai-dev manifest) and renames
// are queued in changelog.d (RISK note on the bead) — pinned here rather than assumed stable.
const SPEC_COMMIT =
  'traceloop/openllmetry semconv manifest gen-ai-dev/1.42.0-dev (github.com/traceloop/openllmetry issue #3515)';

function isRole(value: string): value is Message['role'] {
  return value === 'user' || value === 'assistant' || value === 'system' || value === 'tool';
}

function asRole(value: AnyValue | undefined, fallback: Message['role']): Message['role'] {
  return typeof value === 'string' && isRole(value) ? value : fallback;
}

// A JSON array of Message['parts'] entries, $ref'd against @vetkit/spec's own published
// $defs.MessagePart (traceSchema) rather than a hand-duplicated copy of the shape.
const partsSchema: JsonSchema = {
  $defs: traceSchema.$defs,
  type: 'array',
  items: { $ref: '#/$defs/MessagePart' },
};

// Any valid JSON value — used only to route a content string through the safeParseJson
// chokepoint; schema-shape checking against partsSchema happens separately in jsonToParts.
const anyJsonSchema: JsonSchema = {};

function looksJson(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith('[') || trimmed.startsWith('{');
}

// A JSON value that is already an array of MessagePart-shaped objects is used as-is (structured
// multi-part content); anything else (e.g. traceloop.entity.input/output's raw function
// args/return value) becomes a single text part carrying its canonical JSON serialisation.
function jsonToParts(value: unknown): MessagePart[] {
  const asParts = validateJson<MessagePart[]>(value, partsSchema);
  if (asParts.ok) return asParts.value;
  return [{ type: 'text', content: JSON.stringify(value) }];
}

// Absent content -> no parts (caller decides whether the message itself is still emitted).
// A string is read as plain text unless it looks like JSON, in which case it is parsed and
// validated through the Message-part schema (Edge cases: malformed JSON -> a parse_error part,
// contentState still 'captured' since the attribute was present). A structured (non-string)
// attribute value (already-parsed by the OTLP reader's arrayValue/kvlistValue flattening) is
// validated as-is, without a JSON.parse step.
function contentToParts(value: AnyValue | undefined): MessagePart[] {
  if (value === undefined) return [];
  if (typeof value !== 'string') return jsonToParts(value);
  if (!looksJson(value)) return [{ type: 'text', content: value }];
  const parsed = safeParseJson<unknown>(value, anyJsonSchema);
  if (!parsed.ok) return [{ type: 'parse_error', detail: parsed.error.message }];
  return jsonToParts(parsed.value);
}

interface IndexedEntry {
  role: AnyValue | undefined;
  content: AnyValue | undefined;
}

// `${prefix}.{n}.role` / `${prefix}.{n}.content` for n = 0, 1, 2, ... until neither key exists
// at an index (OTel GenAI conventions' legacy indexed attribute form).
function indexed(attrs: Record<string, AnyValue>, prefix: string): IndexedEntry[] {
  const out: IndexedEntry[] = [];
  for (let n = 0; ; n += 1) {
    const role = attrs[`${prefix}.${n}.role`];
    const content = attrs[`${prefix}.${n}.content`];
    if (role === undefined && content === undefined) break;
    out.push({ role, content });
  }
  return out;
}

const CONTENT_PREFIXES: readonly { prefix: string; role: Message['role'] }[] = [
  { prefix: 'llm.prompts', role: 'user' },
  { prefix: 'llm.completions', role: 'assistant' },
  { prefix: 'gen_ai.prompt', role: 'user' },
  { prefix: 'gen_ai.completion', role: 'assistant' },
];

function messagesFromIndexed(attrs: Record<string, AnyValue>): Message[] {
  const messages: Message[] = [];
  for (const { prefix, role: defaultRole } of CONTENT_PREFIXES) {
    for (const entry of indexed(attrs, prefix)) {
      messages.push({
        role: asRole(entry.role, defaultRole),
        parts: contentToParts(entry.content),
      });
    }
  }
  return messages;
}

// traceloop.entity.input/output (JSON strings) on workflow/task spans: the wrapped function's
// input becomes a user message, its output an assistant message.
function messagesFromEntity(attrs: Record<string, AnyValue>): Message[] {
  const messages: Message[] = [];
  const input = attrs['traceloop.entity.input'];
  if (input !== undefined) messages.push({ role: 'user', parts: contentToParts(input) });
  const output = attrs['traceloop.entity.output'];
  if (output !== undefined) messages.push({ role: 'assistant', parts: contentToParts(output) });
  return messages;
}

function hasCapturedContent(attrs: Record<string, AnyValue>): boolean {
  if (attrs['traceloop.entity.input'] !== undefined) return true;
  if (attrs['traceloop.entity.output'] !== undefined) return true;
  return CONTENT_PREFIXES.some(({ prefix }) =>
    indexed(attrs, prefix).some((entry) => entry.content !== undefined),
  );
}

function numberAttr(value: AnyValue | undefined): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

export const openllmetryDialect: DialectV1 = {
  name: 'openllmetry',
  specCommit: SPEC_COMMIT,

  detect(span: OtlpSpan): boolean {
    const attrs = span.attributes;
    if (attrs['openinference.span.kind'] !== undefined) return false;
    if (typeof attrs['traceloop.span.kind'] === 'string') return true;
    if (Object.keys(attrs).some((key) => key.startsWith('traceloop.entity.'))) return true;
    return attrs['llm.prompts.0.role'] !== undefined;
  },

  isLlmSpan(span: OtlpSpan): boolean {
    const attrs = span.attributes;
    return attrs['traceloop.span.kind'] === 'llm' || attrs['llm.request.type'] !== undefined;
  },

  extractMessages(span: OtlpSpan): Message[] {
    const attrs = span.attributes;
    return [...messagesFromIndexed(attrs), ...messagesFromEntity(attrs)];
  },

  extractUsage(
    span: OtlpSpan,
  ): { inputTokens?: number; outputTokens?: number; totalTokens?: number } | null {
    const attrs = span.attributes;
    const inputTokens = numberAttr(attrs['gen_ai.usage.prompt_tokens']);
    const outputTokens = numberAttr(attrs['gen_ai.usage.completion_tokens']);
    if (inputTokens !== undefined || outputTokens !== undefined) {
      return {
        ...(inputTokens === undefined ? {} : { inputTokens }),
        ...(outputTokens === undefined ? {} : { outputTokens }),
      };
    }
    // llm.usage.total_tokens without a split (pij.13): carried as totalTokens so sumTokens can
    // record tokens.total with input/output left unknown, rather than losing the signal.
    const totalTokens = numberAttr(attrs['llm.usage.total_tokens']);
    if (totalTokens !== undefined) return { totalTokens };
    return null;
  },

  contentState(span: OtlpSpan): 'captured' | 'not_captured' | 'redacted' {
    return hasCapturedContent(span.attributes) ? 'captured' : 'not_captured';
  },

  // pij.13: traceloop.span.kind tool/workflow/task/agent -> Span.kind; 'llm' spans are already
  // routed to 'llm' by isLlmSpan before normalizeTrace ever calls this hook, and any other value
  // (or no attribute) is left undefined so normalizeTrace's 'other' fallback applies.
  spanKind(span: OtlpSpan): 'llm' | 'tool' | 'other' | undefined {
    const kind = span.attributes['traceloop.span.kind'];
    if (kind === 'tool') return 'tool';
    if (kind === 'workflow' || kind === 'task' || kind === 'agent') return 'other';
    return undefined;
  },
};
