// vitest `expect.extend` matcher: `await expect(output).toPassCriterion(criterion, {input})`.
import type { VerdictCache } from '@vetkit/core';
import type { Criterion, JudgeV1 } from '@vetkit/spec';
import { judgeOne, probabilityOf, resolveState } from './judge-one.ts';

export interface VetMatchersOptions {
  readonly judge: JudgeV1;
  readonly threshold?: number;
  readonly cache?: VerdictCache;
}

export interface ToPassCriterionOptions {
  readonly input?: string;
}

export interface MatcherResult {
  readonly pass: boolean;
  readonly message: () => string;
}

// The index signature (in addition to the named member below) is what makes this structurally
// assignable to vitest's `MatchersObject` (Record<string, RawMatcherFn<T, any[]>>) at a
// consumer's `expect.extend(vetMatchers({judge}))` call site, without importing vitest's types
// into this package's public surface. `any` mirrors RawMatcherFn's own (received: any, ...expected)
// shape — vitest's own matcher contract, not a hole opened by this package.
// oxlint-disable typescript/no-explicit-any
export interface VetMatchers {
  readonly [name: string]: (received: any, ...args: any[]) => Promise<MatcherResult>;
  toPassCriterion(
    received: string,
    criterion: Criterion,
    options?: ToPassCriterionOptions,
  ): Promise<MatcherResult>;
}
// oxlint-enable typescript/no-explicit-any

export function vetMatchers(options: VetMatchersOptions): VetMatchers {
  return {
    async toPassCriterion(received, criterion, matcherOptions = {}) {
      const { state, warning } = resolveState(matcherOptions.input, received);
      const { verdict, pass, threshold } = await judgeOne({
        judge: options.judge,
        criterion,
        state,
        ...(options.threshold === undefined ? {} : { threshold: options.threshold }),
        ...(options.cache === undefined ? {} : { cache: options.cache }),
      });
      const model = verdict.model.resolved || verdict.model.requested;
      const probability = verdict.answer === undefined ? undefined : probabilityOf(verdict.answer);
      const passed = pass === true;
      return {
        pass: passed,
        message: () =>
          [
            `expected output to ${passed ? 'not pass' : 'pass'} criterion "${criterion.id}" (status=${verdict.status})`,
            `probability=${probability ?? 'n/a'} threshold=${threshold ?? 'n/a'} model=${model}`,
            warning,
          ]
            .filter((part): part is string => part !== undefined)
            .join(' — '),
      };
    },
  };
}
