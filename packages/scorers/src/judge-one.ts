// Internal helper shared by the three adapters (createScorer, toPromptfooAssertion,
// vetMatchers): judges one ad-hoc, single-case/single-criterion request through
// @vetkit/core's judgeCase — never a hand-rolled request — so the cache key and any
// lock-fitted threshold/tolerance match what `vet run` computes for the same criterion
// (contract aq4.6 pt.3: `criterion` is a full @vetkit/spec Criterion, wordingHash included,
// passed straight through; never re-derived here). Pass/threshold math is decideVerdict's,
// reused as-is (mol-aq4.11 DECISION: emitted scorer modules call the same math instead of
// duplicating it) — this module never reimplements the polarity/escape/threshold comparison.
import { decideVerdict, judgeCase, type VerdictCache } from '@vetkit/core';
import type { Answer, Case, Criterion, JudgeV1, Verdict } from '@vetkit/spec';

/** Placeholder id: each call judges one throwaway Case, never persisted or looked up by id. */
const CASE_ID = 'scorer-case';

export interface JudgeOneInput {
  readonly judge: JudgeV1;
  readonly criterion: Criterion;
  readonly state: string;
  /** Reference answer for a `grader: {kind: 'reference'}` criterion; never entered into `state`. */
  readonly expected?: string;
  /** Falls back to decideVerdict's own default (0.5, uncalibrated) when omitted. */
  readonly threshold?: number;
  readonly cache?: VerdictCache;
}

export interface JudgeOneResult {
  readonly verdict: Verdict;
  readonly pass?: boolean;
  readonly threshold?: number;
  readonly borderline?: boolean;
}

export async function judgeOne(input: JudgeOneInput): Promise<JudgeOneResult> {
  const evalCase: Case = {
    id: CASE_ID,
    input: { state: input.state },
    provenance: {},
    tags: [],
    ...(input.expected === undefined
      ? {}
      : { expected: { value: input.expected, source: 'user' } }),
  };
  const verdicts = await judgeCase({
    judge: input.judge,
    case: evalCase,
    criteria: [input.criterion],
    ...(input.cache === undefined ? {} : { cache: input.cache }),
  });
  const verdict = verdicts[0];
  // judgeCase never throws and always returns exactly one Verdict per criterion (request.ts),
  // so a single-criterion call always yields one — this guard only satisfies
  // noUncheckedIndexedAccess, it is never expected to trigger.
  if (verdict === undefined) {
    throw new Error('judgeCase returned no verdict for the single criterion');
  }
  if (verdict.status !== 'ok' || verdict.answer === undefined) {
    return { verdict };
  }

  const threshold = input.threshold ?? 0.5;
  const decided = decideVerdict(verdict, input.criterion, threshold);
  const merged: Verdict =
    decided.status === undefined
      ? verdict
      : {
          ...verdict,
          status: decided.status,
          ...(decided.cause === undefined ? {} : { cause: decided.cause }),
        };
  return {
    verdict: merged,
    ...(decided.pass === undefined ? {} : { pass: decided.pass }),
    ...(decided.threshold === undefined ? {} : { threshold: decided.threshold }),
    ...(decided.borderline === undefined ? {} : { borderline: decided.borderline }),
  };
}

/** `input` provided -> that is the judged state; missing -> the output stands in, with a warning. */
export function resolveState(
  input: string | undefined,
  output: string,
): { state: string; warning?: string } {
  if (input !== undefined) return { state: input };
  return { state: output, warning: 'no input provided; scoring output alone' };
}

/**
 * A single descriptive probability for observability metadata only — never used to decide
 * pass/fail (that decision always comes from decideVerdict via judgeOne above). Reads a field
 * already present on the judge's Answer for each type; never re-derives decideVerdict's
 * polarity-aware pass value.
 */
export function probabilityOf(answer: Answer): number {
  if (answer.type === 'boolean') return answer.probability;
  if (answer.type === 'choice') return answer.probabilities[answer.choice] ?? answer.confidence;
  return answer.score;
}

export function confidenceOf(answer: Answer): number {
  if (answer.type === 'boolean') return Math.max(answer.probability, 1 - answer.probability);
  return answer.confidence;
}
