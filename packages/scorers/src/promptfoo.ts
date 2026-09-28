// promptfoo `javascript` assertion function: (output, context) => GradingResult. This module
// owns its own GradingResult (below) — the copy in fixtures/promptfoo-grading-result.d.ts is a
// test-only fixture promptfoo.test.ts asserts shape against; production code never imports it
// (this package has zero dependency on the promptfoo package, bead AC).
import type { VerdictCache } from '@vetkit/core';
import type { Criterion, JudgeV1 } from '@vetkit/spec';
import { judgeOne, probabilityOf } from './judge-one.ts';

export interface GradingResult {
  pass: boolean;
  score: number;
  reason: string;
  namedScores?: Record<string, number>;
  metadata?: Record<string, unknown>;
  /** true only for a transport failure (unscored/error) — never for an escape (contract aq4.6 pt.4). */
  graderError?: boolean;
}

export interface ToPromptfooAssertionOptions {
  readonly judge: JudgeV1;
  readonly criterion: Criterion;
  readonly threshold?: number;
  readonly cache?: VerdictCache;
}

export function toPromptfooAssertion(
  options: ToPromptfooAssertionOptions,
): (output: string) => Promise<GradingResult> {
  return async (output) => {
    const { verdict, pass, threshold } = await judgeOne({
      judge: options.judge,
      criterion: options.criterion,
      state: output,
      ...(options.threshold === undefined ? {} : { threshold: options.threshold }),
      ...(options.cache === undefined ? {} : { cache: options.cache }),
    });
    const model = verdict.model.resolved || verdict.model.requested;
    const id = options.criterion.id;

    // Escape/not_applicable never fails the promptfoo suite (contract aq4.6 pt.4): pass:true,
    // score:0, status/reason carry the distinction, graderError stays unset.
    if (verdict.status === 'not_applicable') {
      return {
        pass: true,
        score: 0,
        reason: `${id} escaped: not_applicable`,
        metadata: { status: 'not_applicable', model },
      };
    }
    if (verdict.status !== 'ok' || verdict.answer === undefined || pass === undefined) {
      // verdict.cause is `unknown` (it's a VetError code string in practice, per @vetkit/core's
      // judgeCase); fall back to the status itself for any non-string cause rather than risking
      // Object's default "[object Object]" stringification.
      const causeText = typeof verdict.cause === 'string' ? verdict.cause : verdict.status;
      return {
        pass: false,
        score: 0,
        reason: `${id} unscored: ${causeText}`,
        metadata: { status: verdict.status, model },
        graderError: true,
      };
    }
    const probability = probabilityOf(verdict.answer);
    const appliedThreshold = threshold ?? 0.5;
    return {
      pass,
      score: probability,
      reason: `${id} ${pass ? 'passed' : 'failed'} (p=${probability.toFixed(2)}, threshold=${appliedThreshold.toFixed(2)})`,
      namedScores: { [id]: probability },
      metadata: { model },
    };
  };
}
