// Per-trace normaliser (bead mol-pij.2): cascades through `dialects` in the order given, picks
// the first whose detect() matches any span, then walks the tree causally (parent before child,
// then SpanTree's existing start-time sibling order, ET brief §2 "Precedence cascade") to
// concatenate LLM-span messages and sum tokens once per qualifying span — a nested LLM span is
// never rolled into an ancestor's total (root acceptance J5, "tokens not double-counted").
// Dialect modules (gen_ai, gen_ai_legacy, openinference, openllmetry, vercel) and the default
// cascade order are owned by pij.11: this module only consumes DialectV1, it never imports one.

import type { Message, NormalizedTrace, Span } from '@vetkit/spec';
import { assessCompleteness } from '../completeness/index.ts';
import type { OtlpResource, OtlpResourceSpans, OtlpSpan } from '../reader/index.ts';
import type { SpanNode, SpanTree } from '../reader/tree.ts';
import type { DialectV1, OtlpDiag } from './dialect.ts';

export type { DialectV1, OtlpDiag } from './dialect.ts';

export interface TraceGroup {
  readonly traceId: string;
  readonly resource: OtlpResource;
  readonly spans: OtlpSpan[];
}

// Groups spans across possibly-many resourceSpans blocks by traceId, in file order. A traceId
// that recurs under a later resourceSpans block keeps the first resource seen for its
// attributes/schemaUrl (contract pij.2 revision 6).
export function groupByTraceId(resourceSpansList: readonly OtlpResourceSpans[]): TraceGroup[] {
  const groups = new Map<string, TraceGroup>();
  const result: TraceGroup[] = [];
  for (const rs of resourceSpansList) {
    for (const scopeSpans of rs.scopeSpans) {
      for (const span of scopeSpans.spans) {
        let group = groups.get(span.traceId);
        if (group === undefined) {
          group = { traceId: span.traceId, resource: rs.resource, spans: [] };
          groups.set(span.traceId, group);
          result.push(group);
        }
        group.spans.push(span);
      }
    }
  }
  return result;
}

// Parent before child, then SpanTree's own start-time sibling order (already applied to
// tree.roots / node.children by buildSpanTree).
function causalOrder(tree: SpanTree): SpanNode[] {
  const out: SpanNode[] = [];
  const visit = (node: SpanNode): void => {
    out.push(node);
    for (const child of node.children) visit(child);
  };
  for (const root of tree.roots) visit(root);
  return out;
}

function firstTraceId(tree: SpanTree): string | undefined {
  return tree.roots[0]?.span.traceId ?? tree.byId.values().next().value?.span.traceId;
}

// First dialect (in the given order) whose detect() matches any span in the tree wins. A
// second, different dialect also matching emits a `mixed_dialects` warning but never changes
// the winner (contract pij.2 revision 3).
export function detectDialect(
  tree: SpanTree,
  resource: OtlpResource,
  dialects: readonly DialectV1[],
  onDiag?: (d: OtlpDiag) => void,
  traceId?: string,
): DialectV1 | undefined {
  const nodes = [...tree.byId.values()];
  let winner: DialectV1 | undefined;
  let warned = false;
  for (const dialect of dialects) {
    const matches = nodes.some((node) => dialect.detect(node.span, resource));
    if (!matches) continue;
    if (winner === undefined) {
      winner = dialect;
    } else if (!warned) {
      onDiag?.({
        code: 'mixed_dialects',
        level: 'warn',
        ...(traceId === undefined ? {} : { traceId }),
      });
      warned = true;
    }
  }
  return winner;
}

// Sums extractUsage() once per span for which the winning dialect's isLlmSpan is true; a
// nested LLM span contributes only its own usage, never an ancestor's. Omitted (not null) when
// no LLM span yields usage. A span's bare totalTokens (pij.13: usage reported with no
// input/output split) folds into tokens.total; when that same span's usage also carries a
// split, the split alone determines its contribution, so the bare total is never added on top.
export function sumTokens(
  tree: SpanTree,
  dialect: DialectV1 | undefined,
): NormalizedTrace['tokens'] {
  if (dialect === undefined) return undefined;
  let input: number | undefined;
  let output: number | undefined;
  let bareTotal: number | undefined;
  let any = false;
  for (const node of tree.byId.values()) {
    if (!dialect.isLlmSpan(node.span)) continue;
    const usage = dialect.extractUsage(node.span);
    if (usage === null) continue;
    any = true;
    const hasSplit = usage.inputTokens !== undefined || usage.outputTokens !== undefined;
    if (usage.inputTokens !== undefined) input = (input ?? 0) + usage.inputTokens;
    if (usage.outputTokens !== undefined) output = (output ?? 0) + usage.outputTokens;
    if (!hasSplit && usage.totalTokens !== undefined) {
      bareTotal = (bareTotal ?? 0) + usage.totalTokens;
    }
  }
  if (!any) return undefined;
  const hasTotal = input !== undefined || output !== undefined || bareTotal !== undefined;
  return {
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(hasTotal ? { total: (input ?? 0) + (output ?? 0) + (bareTotal ?? 0) } : {}),
  };
}

export function normalizeTrace(
  tree: SpanTree,
  resource: OtlpResource,
  dialects: readonly DialectV1[],
  onDiag?: (d: OtlpDiag) => void,
  traceId?: string,
): NormalizedTrace {
  const resolvedTraceId = traceId ?? firstTraceId(tree) ?? '';
  const dialect = detectDialect(tree, resource, dialects, onDiag, resolvedTraceId);

  const messages: Message[] = [];
  const spans: Span[] = [];
  for (const node of causalOrder(tree)) {
    const otlpSpan = node.span;
    if (dialect !== undefined && dialect.isLlmSpan(otlpSpan)) {
      const start = messages.length;
      messages.push(...dialect.extractMessages(otlpSpan, tree));
      spans.push({
        spanId: otlpSpan.spanId,
        name: otlpSpan.name,
        kind: 'llm',
        messageRange: [start, messages.length],
      });
    } else {
      // pij.13: a dialect's optional spanKind() maps a non-LLM span to a more specific kind
      // (e.g. 'tool'); undefined (no hook, or the hook declines this span) keeps 'other'.
      const kind = dialect?.spanKind?.(otlpSpan) ?? 'other';
      spans.push({ spanId: otlpSpan.spanId, name: otlpSpan.name, kind });
    }
  }

  const tokens = sumTokens(tree, dialect);
  const completeness = assessCompleteness(
    tree,
    [...tree.byId.values()].map((n) => n.span),
    dialect,
  );

  return {
    traceId: resolvedTraceId,
    spans,
    messages,
    dialect: dialect?.name ?? 'unknown',
    dialectVersion: dialect?.specCommit ?? 'unknown',
    ...(resource.schemaUrl === undefined ? {} : { schemaUrl: resource.schemaUrl }),
    completeness: {
      contentCaptured: completeness.contentCaptured,
      truncated: completeness.truncated,
      missingParents: completeness.missingParents.length > 0,
    },
    ...(tokens === undefined ? {} : { tokens }),
  };
}
