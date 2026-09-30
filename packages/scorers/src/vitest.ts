// The `@vetkit/scorers/vitest` entry: importing it augments vitest's `expect(x)` with
// `toPassCriterion` and re-exports `vetMatchers`. It lives on a subpath, not the root entry,
// because vitest is an optional peer — a root-level augmentation would break `createScorer`
// users without vitest under skipLibCheck:false.
import type { Criterion } from '@vetkit/spec';
import type { ToPassCriterionOptions } from './matcher.ts';

declare module 'vitest' {
  // vitest's own `Assertion` declarations disagree on their type parameters (5.0.2), so a merge
  // into `Assertion` cannot type-check under skipLibCheck:false; `Matchers` is the interface
  // `Assertion` and `AsymmetricMatchersContaining` both extend, and repeats vitest's parameters.
  // oxlint-disable-next-line typescript/no-unused-vars -- the parameters must match vitest's.
  interface Matchers<R extends void | Promise<void> = void | Promise<void>, T = unknown> {
    toPassCriterion(criterion: Criterion, options?: ToPassCriterionOptions): Promise<void>;
  }
}

export { vetMatchers } from './matcher.ts';
export type { ToPassCriterionOptions, VetMatchers, VetMatchersOptions } from './matcher.ts';
