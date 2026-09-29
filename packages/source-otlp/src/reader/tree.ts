// Span tree. Causality first, timestamps second (ET brief OTEL-5): a span sits
// under its parent whatever the clocks say, and only siblings are ordered by startTimeUnixNano.
// A parentSpanId that never arrived is listed in missingParents and its span becomes a root,
// never a throw (OTEL-4).

import type { AnyValue, OtlpSpan } from './index.ts';

export interface SpanNode {
  span: OtlpSpan;
  parent?: SpanNode;
  children: SpanNode[];
}

export interface SpanTree {
  roots: SpanNode[];
  byId: Map<string, SpanNode>;
  missingParents: string[];
  warnings: string[];
  attributes(spanId: string): Record<string, AnyValue>;
}

function byStart(a: SpanNode, b: SpanNode): number {
  const x = BigInt(a.span.startTimeUnixNano);
  const y = BigInt(b.span.startTimeUnixNano);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function buildSpanTree(spans: readonly OtlpSpan[]): SpanTree {
  const warnings: string[] = [];
  const byId = new Map<string, SpanNode>();
  for (const span of spans) {
    if (byId.has(span.spanId)) {
      warnings.push(`duplicate spanId ${span.spanId}; the last one wins`);
    }
    byId.set(span.spanId, { span, children: [] });
  }

  const roots: SpanNode[] = [];
  const missing = new Set<string>();
  for (const node of byId.values()) {
    const parentId = node.span.parentSpanId;
    const parent = parentId === undefined ? undefined : byId.get(parentId);
    if (parent === undefined || parent === node) {
      if (parentId !== undefined && parent === undefined) missing.add(parentId);
      roots.push(node);
      continue;
    }
    node.parent = parent;
    parent.children.push(node);
  }

  // Array.prototype.sort is stable, so equal start times keep input order.
  roots.sort(byStart);
  for (const node of byId.values()) node.children.sort(byStart);

  return {
    roots,
    byId,
    missingParents: [...missing],
    warnings,
    attributes: (spanId) => byId.get(spanId)?.span.attributes ?? {},
  };
}
