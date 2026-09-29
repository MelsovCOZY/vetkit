import { expectTypeOf, test } from 'vitest';
import type { OtlpResource, OtlpSpan } from '../reader/index.ts';
import type { SpanTree } from '../reader/tree.ts';
import type { DialectV1, OtlpDiag } from './dialect.ts';

test('DialectV1.name is the fixed five-dialect union', () => {
  expectTypeOf<DialectV1['name']>().toEqualTypeOf<
    'gen_ai' | 'gen_ai_legacy' | 'openinference' | 'openllmetry' | 'vercel'
  >();
});

test('DialectV1.specCommit is an optional string', () => {
  expectTypeOf<DialectV1['specCommit']>().toEqualTypeOf<string | undefined>();
});

test('DialectV1.detect takes (span, resource) and returns boolean', () => {
  expectTypeOf<DialectV1['detect']>().parameters.toEqualTypeOf<[OtlpSpan, OtlpResource]>();
  expectTypeOf<DialectV1['detect']>().returns.toEqualTypeOf<boolean>();
});

test('DialectV1.isLlmSpan takes a span and returns boolean', () => {
  expectTypeOf<DialectV1['isLlmSpan']>().parameters.toEqualTypeOf<[OtlpSpan]>();
  expectTypeOf<DialectV1['isLlmSpan']>().returns.toEqualTypeOf<boolean>();
});

test('DialectV1.extractMessages takes (span, tree, optional onDiag) and returns Message[]', () => {
  expectTypeOf<DialectV1['extractMessages']>().parameters.toEqualTypeOf<
    [OtlpSpan, SpanTree, ((d: OtlpDiag) => void)?]
  >();
});

test('a dialect whose extractMessages ignores onDiag still satisfies DialectV1', () => {
  const legacy = {
    name: 'vercel',
    detect: () => true,
    isLlmSpan: () => true,
    extractMessages: (_span: OtlpSpan, _tree: SpanTree) => [],
    extractUsage: () => null,
    contentState: () => 'captured',
  } as const satisfies DialectV1;
  expectTypeOf(legacy).toMatchTypeOf<DialectV1>();
});

test('DialectV1.extractUsage returns a partial token pair/total or null', () => {
  expectTypeOf<DialectV1['extractUsage']>().returns.toEqualTypeOf<{
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  } | null>();
});

test('DialectV1.spanKind is an optional hook', () => {
  expectTypeOf<DialectV1['spanKind']>().toEqualTypeOf<
    ((span: OtlpSpan) => 'llm' | 'tool' | 'other' | undefined) | undefined
  >();
});

test("DialectV1.contentState returns 'captured' | 'not_captured' | 'redacted'", () => {
  expectTypeOf<DialectV1['contentState']>().returns.toEqualTypeOf<
    'captured' | 'not_captured' | 'redacted'
  >();
});

test('OtlpDiag is code + fixed warn level + optional traceId/detail', () => {
  expectTypeOf<OtlpDiag>().toEqualTypeOf<{
    readonly code: string;
    readonly level: 'warn';
    readonly traceId?: string;
    readonly detail?: string;
  }>();
});
