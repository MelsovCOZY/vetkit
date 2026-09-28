import { expectTypeOf, test } from 'vitest';
import type { Case, Criterion, Model, SpecVersionDoc, Verdict } from './index.ts';

test('SpecVersionDoc.specVersion is the literal type "v1"', () => {
  expectTypeOf<SpecVersionDoc['specVersion']>().toEqualTypeOf<'v1'>();
});

// R2: the generated IR types must be narrow object types (every field named), never
// Record<string, unknown> — codegen dropping a keyword silently would erase field names
// and this assertion would stop compiling.
test('Criterion is a narrow object type, not Record<string, unknown>', () => {
  expectTypeOf<Criterion['id']>().toEqualTypeOf<string>();
  expectTypeOf<Criterion['type']>().toEqualTypeOf<'boolean' | 'choice' | 'score'>();
  expectTypeOf<Criterion>().not.toEqualTypeOf<Record<string, unknown>>();
});

test('Case is a narrow object type, not Record<string, unknown>', () => {
  expectTypeOf<Case['id']>().toEqualTypeOf<string>();
  expectTypeOf<Case['tags']>().toEqualTypeOf<string[]>();
  expectTypeOf<Case>().not.toEqualTypeOf<Record<string, unknown>>();
});

test('Verdict is a narrow object type, not Record<string, unknown>', () => {
  expectTypeOf<Verdict['caseId']>().toEqualTypeOf<string>();
  expectTypeOf<Verdict['model']>().toEqualTypeOf<Model>();
  expectTypeOf<Verdict>().not.toEqualTypeOf<Record<string, unknown>>();
});
