// Judge request builder and per-case judging (DECISION: one request per case — every criterion
// of a case goes to the judge as one keyed question inside a single doJudge call). Consumed only
// through runJudge in run.ts (DECISION: core seams named).
//
// Channel rule (eval-quality brief §4 items 9-10, §5.2 item 13): the judged content — the case's
// `input.state` — goes into the request's `state` and nowhere else; a reference answer
// (Case.expected, via renderReference) goes into that question's `instructions` and never into
// `state`.
import { createHash } from 'node:crypto';
import {
  CEV_ERROR_CODES,
  VetError,
  type Case,
  type Criterion,
  type JudgeResponse,
  type JudgeV1,
  type Question,
  type Verdict,
} from '@vetkit/spec';
import type { CachedJudgment, VerdictCache } from './cache.ts';
import { renderReference } from './reference.ts';

/** Option key the escape wording is sent under (boolean and choice questions). */
const ESCAPE_KEY = 'escape';

export interface JudgeRequest {
  state: string;
  questions: Record<string, Question>;
}

export interface BuildRequestOptions {
  /** Per-criterion option order (Gauntlet C position swap); keys are never changed. */
  readonly optionOrder?: Readonly<Record<string, readonly string[]>>;
}

function orderOptions(
  options: Record<string, string>,
  order: readonly string[] | undefined,
): Record<string, string> {
  if (order === undefined) return options;
  const keys = [
    ...order.filter((k) => Object.hasOwn(options, k)),
    ...Object.keys(options).filter((k) => !order.includes(k)),
  ];
  return Object.fromEntries(keys.map((k) => [k, options[k] ?? '']));
}

function withEscape(options: Record<string, string>, escape: string): Record<string, string> {
  // Contract allows `escape` to name an existing option key; only add it when it does not.
  if (Object.hasOwn(options, escape)) return options;
  return { ...options, [ESCAPE_KEY]: escape };
}

function toQuestion(
  criterion: Criterion,
  evalCase: Case,
  order: readonly string[] | undefined,
): Question {
  const instructions = renderReference(criterion, evalCase) ?? criterion.instructions;

  if (criterion.type === 'score') {
    return { type: 'score', instructions, criteria: [...criterion.criteria] };
  }

  const escape = String(criterion.escape);
  if (criterion.type === 'choice') {
    return {
      type: 'choice',
      instructions,
      criteria: orderOptions(withEscape(criterion.criteria, escape), order),
    };
  }

  // Boolean → 3-way choice {yes, no, escape} (DECISION: escape and pass semantics): Jev never
  // abstains on a plain noul, so the escape wording is both an option and appended to the
  // instructions.
  return {
    type: 'choice',
    instructions: `${instructions} Answer "${ESCAPE_KEY}" when: ${escape}`,
    criteria: orderOptions({ yes: 'Yes.', no: 'No.', [ESCAPE_KEY]: escape }, order),
  };
}

export function buildRequest(
  evalCase: Case,
  criteria: readonly Criterion[],
  options: BuildRequestOptions = {},
): JudgeRequest {
  const questions: Record<string, Question> = {};
  for (const criterion of criteria) {
    questions[criterion.id] = toQuestion(criterion, evalCase, options.optionOrder?.[criterion.id]);
  }
  return { state: evalCase.input.state, questions };
}

/**
 * sha256 over (state, each criterion's wordingHash in id order, model, rendered reference text,
 * option order). `model` is the judge's declared identity (JudgeV1.id) used for lookup —
 * `model.resolved` is only known after a call, so it is stored inside the entry instead
 * (bead RISK note); a different declared model is a different key, hence a miss.
 */
export function cacheKey(
  evalCase: Case,
  criteria: readonly Criterion[],
  model: string,
  options: BuildRequestOptions = {},
): string {
  const sorted = criteria.toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const material = {
    state: evalCase.input.state,
    wording: sorted.map((c) => [c.id, c.wordingHash]),
    model,
    references: sorted.map((c) => [c.id, renderReference(c, evalCase)]),
    optionOrder: sorted.map((c) => [c.id, options.optionOrder?.[c.id] ?? null]),
  };
  return createHash('sha256').update(JSON.stringify(material)).digest('hex');
}

export interface JudgeCaseInput extends BuildRequestOptions {
  readonly judge: JudgeV1;
  readonly case: Case;
  readonly criteria: readonly Criterion[];
  readonly cache?: VerdictCache;
  readonly signal?: AbortSignal;
}

function verdictModel(model: JudgeResponse['model']): Verdict['model'] {
  const out: Verdict['model'] = {
    requested: model.requested,
    resolved: model.resolved,
    transport: model.transport,
    pinned: model.pinned,
  };
  if (model.provider !== undefined) out.provider = model.provider;
  if (model.releaseDate !== undefined) out.releaseDate = model.releaseDate;
  return out;
}

function unscored(input: JudgeCaseInput, cause: string): Verdict[] {
  const model: Verdict['model'] = {
    requested: input.judge.id,
    resolved: '',
    transport: input.judge.capabilities.transport,
    pinned: input.judge.capabilities.pinned,
  };
  return input.criteria.map((c) => ({
    caseId: input.case.id,
    criterionId: c.id,
    status: 'unscored',
    model,
    cacheHit: false,
    cause,
  }));
}

function toVerdicts(input: JudgeCaseInput, judged: CachedJudgment, cacheHit: boolean): Verdict[] {
  const model = verdictModel(judged.model);
  return input.criteria.map((c): Verdict => {
    const answer = judged.answers[c.id];
    if (answer === undefined) {
      return {
        caseId: input.case.id,
        criterionId: c.id,
        status: 'error',
        model,
        cacheHit,
        cause: CEV_ERROR_CODES.JUDGE_BAD_RESPONSE,
      };
    }
    return { caseId: input.case.id, criterionId: c.id, status: 'ok', answer, model, cacheHit };
  });
}

/** One doJudge call per case; returns one Verdict per criterion and never throws on judge failure. */
export async function judgeCase(input: JudgeCaseInput): Promise<Verdict[]> {
  if (input.signal?.aborted === true) return unscored(input, CEV_ERROR_CODES.JUDGE_TIMEOUT);

  const key = cacheKey(input.case, input.criteria, input.judge.id, input);
  const cached = await input.cache?.get(key);
  if (cached !== undefined) return toVerdicts(input, cached, true);

  const request = buildRequest(input.case, input.criteria, input);
  let response: JudgeResponse;
  try {
    response = await input.judge.doJudge(
      input.signal === undefined ? request : { ...request, signal: input.signal },
    );
  } catch (err) {
    return unscored(input, VetError.isInstance(err) ? err.code : CEV_ERROR_CODES.JUDGE_UNAVAILABLE);
  }

  const judged: CachedJudgment = {
    answers: response.answers,
    usage: response.usage,
    model: response.model,
  };
  // A response missing any answer key is not cached, so a rerun asks the judge again.
  const complete = input.criteria.every((c) => judged.answers[c.id] !== undefined);
  if (complete) await input.cache?.set(key, judged);
  return toVerdicts(input, judged, false);
}
