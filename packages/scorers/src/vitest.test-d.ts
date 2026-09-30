import { expect, expectTypeOf, test } from 'vitest';
import type { Criterion } from '@vetkit/spec';
import { vetMatchers } from './vitest.ts';

declare const criterion: Criterion;

test('toPassCriterion is a member of expect(x) after importing @vetkit/scorers/vitest', () => {
  expectTypeOf(expect('')).toHaveProperty('toPassCriterion');
  expectTypeOf(expect('').toPassCriterion(criterion)).toEqualTypeOf<Promise<void>>();
  expectTypeOf(expect('').toPassCriterion(criterion, { input: 'q' })).toEqualTypeOf<
    Promise<void>
  >();
  expectTypeOf(vetMatchers).toBeFunction();
});
