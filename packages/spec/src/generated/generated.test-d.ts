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

// DECISION (turn 9, contract amendment): Criterion.passWhen (choice only, string[])
// and Criterion.escapeThreshold (number, 0..1 default 0.5), docs/contracts/j1.md.
// Bug classified-evals-mol-0nw.20: passWhen is required (minItems 1) on choice, so it is
// a non-empty tuple there; boolean/score keep the optional base field (schema forbids it).
test('Criterion.passWhen is required and non-empty on choice; escapeThreshold is optional', () => {
  type ChoicePassWhen = Extract<Criterion, { type: 'choice' }>['passWhen'];
  expectTypeOf<ChoicePassWhen>().toExtend<[string, ...string[]]>();
  expectTypeOf<undefined>().not.toExtend<ChoicePassWhen>();
  expectTypeOf<[]>().not.toExtend<ChoicePassWhen>();
  expectTypeOf<Extract<Criterion, { type: 'boolean' }>['passWhen']>().toEqualTypeOf<
    string[] | undefined
  >();
  expectTypeOf<Criterion['escapeThreshold']>().toEqualTypeOf<number | undefined>();
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
