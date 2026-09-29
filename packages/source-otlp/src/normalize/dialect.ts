// DialectV1: the pure attribute-mapping contract each OTLP GenAI convention module
// implements. Detection order, message concatenation and token summation are cascade
// concerns that live in ./index.ts; a dialect only ever answers questions about one span.
// The dialect modules themselves (gen_ai, gen_ai_legacy, openinference, openllmetry, vercel)
// live under ../dialects.

import type { Message } from '@vetkit/spec';
import type { OtlpResource, OtlpSpan } from '../reader/index.ts';
import type { SpanTree } from '../reader/tree.ts';

export interface DialectV1 {
  readonly name: 'gen_ai' | 'gen_ai_legacy' | 'openinference' | 'openllmetry' | 'vercel';
  // The dialect module's pinned semconv/spec commit; absent when a dialect does not track one.
  // normalizeTrace reads it as NormalizedTrace.dialectVersion.
  readonly specCommit?: string;
  detect(span: OtlpSpan, resource: OtlpResource): boolean;
  isLlmSpan(span: OtlpSpan): boolean;
  // onDiag, when given, receives a warning for each message role the dialect had to map to a
  // fallback; it never carries message content. Existing implementations may omit the parameter.
  extractMessages(span: OtlpSpan, tree: SpanTree, onDiag?: (d: OtlpDiag) => void): Message[];
  extractUsage(
    span: OtlpSpan,
  ): { inputTokens?: number; outputTokens?: number; totalTokens?: number } | null;
  contentState(span: OtlpSpan): 'captured' | 'not_captured' | 'redacted';
  // Optional: maps a non-LLM span (isLlmSpan false) to a Span.kind other than the
  // 'other' default. Dialects that don't implement it, or that return undefined for a given
  // span, leave normalizeTrace's 'other' fallback in place.
  spanKind?(span: OtlpSpan): 'llm' | 'tool' | 'other' | undefined;
}

// Warning-only diagnostic channel for otlpSource/normalizeTrace:
// never thrown, always passed to the caller's onDiag.
export interface OtlpDiag {
  readonly code: string;
  readonly level: 'warn';
  readonly traceId?: string;
  readonly detail?: string;
}
