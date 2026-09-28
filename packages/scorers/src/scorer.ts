// Braintrust/autoevals `Score` and Evalite `createScorer` both accept a scoring function
// returning a number-or-null-ish shape; null is the sanctioned "skip this" signal for both
// (UX brief §2.5 DECISION) — never 0, which would read as a real fail.
import type { VerdictCache } from '@vetkit/core';
import type { Criterion, JudgeV1 } from '@vetkit/spec';
import { confidenceOf, judgeOne, probabilityOf, resolveState } from './judge-one.ts';

export interface ScorerCase {
  readonly input?: string;
  readonly output: string;
  readonly expected?: string;
}

export interface ScorerMetadata {
  readonly probability?: number;
  readonly confidence?: number;
  readonly status: string;
  readonly model: string;
  readonly warning?: string;
}

export interface ScorerResult {
  readonly name: string;
  /** null means unscored or not_applicable — never 0 — so Braintrust/Evalite/autoevals skip it. */
  readonly score: 1 | 0 | null;
  readonly metadata: ScorerMetadata;
}

export interface CreateScorerOptions {
  readonly judge: JudgeV1;
  readonly criterion: Criterion;
  readonly threshold?: number;
  readonly cache?: VerdictCache;
}

export function createScorer(
  options: CreateScorerOptions,
): (evalCase: ScorerCase) => Promise<ScorerResult> {
  return async (evalCase) => {
    const { state, warning } = resolveState(evalCase.input, evalCase.output);
    const { verdict, pass } = await judgeOne({
      judge: options.judge,
      criterion: options.criterion,
      state,
      ...(options.threshold === undefined ? {} : { threshold: options.threshold }),
      ...(evalCase.expected === undefined ? {} : { expected: evalCase.expected }),
      ...(options.cache === undefined ? {} : { cache: options.cache }),
    });
    const model = verdict.model.resolved || verdict.model.requested;
    const name = options.criterion.id;

    if (verdict.status !== 'ok' || verdict.answer === undefined || pass === undefined) {
      return {
        name,
        score: null,
        metadata: { status: verdict.status, model, ...(warning === undefined ? {} : { warning }) },
      };
    }
    return {
      name,
      score: pass ? 1 : 0,
      metadata: {
        probability: probabilityOf(verdict.answer),
        confidence: confidenceOf(verdict.answer),
        status: verdict.status,
        model,
        ...(warning === undefined ? {} : { warning }),
      },
    };
  };
}
