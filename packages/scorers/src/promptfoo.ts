// promptfoo `javascript` assertion function: (output, context) => GradingResult. This module
// owns its own GradingResult (below) — the copy in fixtures/promptfoo-grading-result.d.ts is a
// test-only fixture promptfoo.test.ts asserts shape against; production code never imports it
// (this package has zero dependency on the promptfoo package).
import type { VerdictCache } from '@vetkit/core';
import type { Criterion, JudgeV1, Lock } from '@vetkit/spec';
import { judgeOne, probabilityOf } from './judge-one.ts';

export interface GradingResult {
  pass: boolean;
  score: number;
  reason: string;
  namedScores?: Record<string, number>;
  metadata?: Record<string, unknown>;
  /** true only for a transport failure (unscored/error) — never for an escape. */
  graderError?: boolean;
}

/**
 * The structural subset of promptfoo's assertion context this adapter reads; keeping it local is
 * what leaves this package with zero promptfoo dependency.
 */
export interface PromptfooAssertionContext {
  readonly prompt?: string;
  readonly vars?: Readonly<Record<string, unknown>>;
}

export interface ToPromptfooAssertionOptions {
  readonly judge: JudgeV1;
  readonly criterion: Criterion;
  /** The project's criteria.lock.json (read by the caller); supplies threshold and tolerance. */
  readonly lock?: Lock;
  /** The var holding the judged state (default 'input'). */
  readonly inputVar?: string;
  /** The var holding the reference answer (default 'expected'). */
  readonly expectedVar?: string;
  readonly threshold?: number;
  readonly cache?: VerdictCache;
}

type StateSource = 'vars' | 'prompt' | 'output';

// A non-string var, or an empty prompt, is skipped: the next source stands in.
function pickState(
  output: string,
  context: PromptfooAssertionContext | undefined,
  inputVar: string,
): { state: string; stateSource: StateSource } {
  const fromVars = context?.vars?.[inputVar];
  if (typeof fromVars === 'string') return { state: fromVars, stateSource: 'vars' };
  const fromPrompt = context?.prompt;
  if (fromPrompt !== undefined && fromPrompt !== '') {
    return { state: fromPrompt, stateSource: 'prompt' };
  }
  return { state: output, stateSource: 'output' };
}

export function toPromptfooAssertion(
  options: ToPromptfooAssertionOptions,
): (output: string, context?: PromptfooAssertionContext) => Promise<GradingResult> {
  const inputVar = options.inputVar ?? 'input';
  const expectedVar = options.expectedVar ?? 'expected';
  return async (output, context) => {
    const { state, stateSource } = pickState(output, context, inputVar);
    const expected = context?.vars?.[expectedVar];
    const { verdict, pass, threshold, calibration } = await judgeOne({
      judge: options.judge,
      criterion: options.criterion,
      state,
      ...(options.lock === undefined ? {} : { lock: options.lock }),
      ...(typeof expected === 'string' ? { expected } : {}),
      ...(options.threshold === undefined ? {} : { threshold: options.threshold }),
      ...(options.cache === undefined ? {} : { cache: options.cache }),
    });
    const model = verdict.model.resolved || verdict.model.requested;
    const id = options.criterion.id;

    // Escape/not_applicable never fails the promptfoo suite: pass:true,
    // score:0, status/reason carry the distinction, graderError stays unset.
    if (verdict.status === 'not_applicable') {
      return {
        pass: true,
        score: 0,
        reason: `${id} escaped: not_applicable`,
        metadata: { status: 'not_applicable', model, calibration, stateSource },
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
        metadata: { status: verdict.status, model, calibration, stateSource },
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
      metadata: { model, calibration, stateSource },
    };
  };
}
