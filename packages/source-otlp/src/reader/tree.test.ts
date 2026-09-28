import { describe, expect, test } from 'vitest';
import type { OtlpSpan } from './index.ts';
import { buildSpanTree } from './tree.ts';

const TRACE = '5b8efff798038103d269b633813fc60c';
const MS = 1_000_000n;

function span(
  spanId: string,
  parentSpanId: string | undefined,
  startMs: number,
  extra: Partial<OtlpSpan> = {},
): OtlpSpan {
  const start = BigInt(startMs) * MS + 1_700_000_000_000_000_000n;
  return {
    traceId: TRACE,
    spanId,
    ...(parentSpanId === undefined ? {} : { parentSpanId }),
    name: spanId,
    kind: 1,
    startTimeUnixNano: start.toString(),
    endTimeUnixNano: (start + 1000n * MS).toString(),
    attributes: { 'x.id': spanId },
    events: [],
    links: [],
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    status: { code: 0 },
    idEncoding: 'hex',
    ...extra,
  };
}

describe('buildSpanTree', () => {
  test('a dangling parent is listed in missingParents, not thrown, and its child is a root', () => {
    const tree = buildSpanTree([span('a', undefined, 0), span('b', 'ghost', 10)]);

    expect(tree.missingParents).toEqual(['ghost']);
    expect(tree.roots.map((n) => n.span.spanId)).toEqual(['a', 'b']);
  });

  test('a child starting 200 ms before its parent keeps its parent (OTEL-5)', () => {
    const tree = buildSpanTree([span('child', 'parent', 0), span('parent', undefined, 200)]);

    expect(tree.roots.map((n) => n.span.spanId)).toEqual(['parent']);
    expect(tree.roots[0]?.children.map((n) => n.span.spanId)).toEqual(['child']);
    expect(tree.byId.get('child')?.parent?.span.spanId).toBe('parent');
    expect(tree.missingParents).toEqual([]);
  });

  test('siblings are ordered by startTime after causality', () => {
    const tree = buildSpanTree([
      span('root', undefined, 0),
      span('late', 'root', 300),
      span('early', 'root', 100),
      span('grandchild', 'late', 50),
    ]);

    const root = tree.roots[0];
    expect(root?.children.map((n) => n.span.spanId)).toEqual(['early', 'late']);
    expect(root?.children[1]?.children.map((n) => n.span.spanId)).toEqual(['grandchild']);
  });

  test('duplicate spanIds: the last one wins and a warning is recorded', () => {
    const tree = buildSpanTree([
      span('a', undefined, 0, { name: 'first' }),
      span('a', undefined, 0, { name: 'second' }),
    ]);

    expect(tree.byId.get('a')?.span.name).toBe('second');
    expect(tree.roots).toHaveLength(1);
    expect(tree.warnings.some((w) => w.includes('a'))).toBe(true);
  });

  test('attributes(spanId) returns the flattened attributes of that span', () => {
    const tree = buildSpanTree([span('a', undefined, 0)]);

    expect(tree.attributes('a')).toEqual({ 'x.id': 'a' });
    expect(tree.attributes('missing')).toEqual({});
  });
});
