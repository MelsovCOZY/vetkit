// Gauntlet A wording checks:
// a criterion whose decision changes with rewording is not measuring the trace. The generator
// (GeneratorV1) drafts the wordings, core validates them (DECISION (structured output)), and the
// judge sees them through runJudge with the cache bypassed. Paraphrases gate on decision
// agreement; max |ΔP| is a diagnostic only. Polarity compares decisions after label remapping,
// the negated wording at its own fitted threshold, never probabilities across polarities. The
// negated wording is returned only as its hash and is never written to criteria.yaml or the lock.
import { createHash } from 'node:crypto';
import {
  safeParseJson,
  validateJson,
  type Answer,
  type Case,
  type Criterion,
  type GauntletOutcome,
  type GeneratorV1,
  type JsonSchema,
  type JudgeV1,
  type LockReason,
  type ParseResult,
} from '@vetkit/spec';
import { runJudge, type RunVerdict } from '../run.ts';
import { fitThreshold, type CalibrationLabel } from './calibrate.ts';

const MIN_PARAPHRASES = 3;
const DEFAULT_K = 4;
const DEFAULT_MIN_AGREEMENT = 0.9;
const EPS = 1e-9;
const NEGATION = /\b(?:not|never|no)\b|n't\b/i;

const PARAPHRASE_SYSTEM =
  'Rewrite the evaluation question in different words without changing its meaning. ' +
  'Keep it a yes/no question about the same property. Return JSON only.';
const NEGATION_SYSTEM =
  'Rewrite the evaluation question as its logical negation, so a yes becomes a no. ' +
  'Use an explicit negation (not, never, no). Return JSON only.';

const PARAPHRASE_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['paraphrases'],
  properties: { paraphrases: { type: 'array', items: { type: 'string' } } },
};
const NEGATION_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['negated'],
  properties: { negated: { type: 'string', minLength: 1 } },
};

export type GauntletWordingSkipReason =
  | 'no_generator'
  | 'bad_generator_output'
  | 'too_few_paraphrases'
  | 'no_negation'
  | 'not_boolean'
  | 'no_threshold'
  | 'no_comparable_cases';

export interface WordingJudgeOptions {
  /** The criterion's pass threshold (default runJudge's uncalibrated 0.5). */
  readonly threshold?: number;
  readonly minAgreement?: number;
}

export interface ParaphraseOptions extends WordingJudgeOptions {
  /** Paraphrases requested; at least 3. */
  readonly k?: number;
}

export interface ParaphraseResult {
  readonly result: GauntletOutcome;
  readonly reasons: LockReason[];
  readonly reason?: GauntletWordingSkipReason;
  /** Why the generator output was rejected (error code), when reason is bad_generator_output. */
  readonly cause?: string;
  /** Decision agreement with the original, one per usable paraphrase (aligned with paraphrases). */
  readonly agreement: number[];
  /** max |P_paraphrase − P_original| over judged cases; diagnostic only. */
  readonly spread?: number;
  readonly paraphrases: string[];
  /** e.g. `fewer_paraphrases` when the generator returned fewer than k. */
  readonly notes: string[];
}

export interface PolarityResult {
  readonly result: GauntletOutcome;
  readonly reasons: LockReason[];
  readonly reason?: GauntletWordingSkipReason;
  readonly cause?: string;
  readonly agreement?: number;
  readonly negatedThreshold?: number;
  /** sha256 of the negated wording; its text is discarded after the check. */
  readonly negatedHash?: string;
}

type Decision = 'pass' | 'fail' | 'escape';

type Generated<T> = { ok: true; value: T } | { ok: false; cause: string };

async function generate<T>(
  generator: GeneratorV1,
  system: string,
  prompt: string,
  name: string,
  schema: JsonSchema,
): Promise<Generated<T>> {
  let parsed: ParseResult<T>;
  try {
    const out = await generator.doGenerate({
      system,
      prompt,
      schema: { name, jsonSchema: schema },
    });
    parsed =
      out.value === undefined
        ? safeParseJson<T>(out.text ?? '', schema)
        : validateJson<T>(out.value, schema);
  } catch (err) {
    return { ok: false, cause: err instanceof Error ? err.name : 'generator_error' };
  }
  return parsed.ok ? { ok: true, value: parsed.value } : { ok: false, cause: parsed.error.code };
}

async function judgeWording(
  criterion: Criterion,
  instructions: string,
  cases: readonly Case[],
  judge: JudgeV1,
  threshold: number | undefined,
): Promise<Map<string, RunVerdict>> {
  const verdicts = await runJudge({
    cases,
    criteria: [{ ...criterion, instructions }],
    judge,
    bypassCache: true,
    ...(threshold === undefined ? {} : { threshold }),
  });
  return new Map(verdicts.map((v) => [v.caseId, v]));
}

function decision(v: RunVerdict | undefined): Decision | undefined {
  if (v?.status === 'not_applicable') return 'escape';
  if (v?.status !== 'ok' || v.pass === undefined) return undefined;
  return v.pass ? 'pass' : 'fail';
}

/** Raw P(yes) (boolean/choice pass mass, score level) for the ΔP diagnostic. */
function probability(criterion: Criterion, answer: Answer | undefined): number | undefined {
  if (answer === undefined) return undefined;
  if (answer.type === 'boolean') return answer.probability;
  if (answer.type === 'score') return answer.score;
  if (criterion.type === 'choice') {
    return criterion.passWhen.reduce((sum, k) => sum + (answer.probabilities[k] ?? 0), 0);
  }
  return answer.probabilities['yes'] ?? 0;
}

function normalise(text: string): string {
  return text.trim().replaceAll(/\s+/g, ' ').toLowerCase();
}

function paraphraseSkipped(
  reason: GauntletWordingSkipReason,
  extra: Partial<ParaphraseResult> = {},
): ParaphraseResult {
  return {
    result: 'skipped',
    reasons: [],
    agreement: [],
    paraphrases: [],
    notes: [],
    reason,
    ...extra,
  };
}

export async function gauntletParaphrase(
  criterion: Criterion,
  sampleCases: readonly Case[],
  generator: GeneratorV1 | undefined,
  judge: JudgeV1,
  options: ParaphraseOptions = {},
): Promise<ParaphraseResult> {
  if (generator === undefined) return paraphraseSkipped('no_generator');
  const k = Math.max(MIN_PARAPHRASES, options.k ?? DEFAULT_K);
  const minAgreement = options.minAgreement ?? DEFAULT_MIN_AGREEMENT;

  const generated = await generate<{ paraphrases: string[] }>(
    generator,
    PARAPHRASE_SYSTEM,
    `Question: ${criterion.instructions}\nWrite ${k} paraphrases as {"paraphrases": [...]}.`,
    'paraphrases',
    PARAPHRASE_SCHEMA,
  );
  if (!generated.ok) return paraphraseSkipped('bad_generator_output', { cause: generated.cause });

  const notes: string[] = [];
  const seen = new Set([normalise(criterion.instructions)]);
  const candidates: string[] = [];
  for (const p of generated.value.paraphrases.slice(0, k)) {
    const key = normalise(p);
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    candidates.push(p.trim());
  }
  if (generated.value.paraphrases.length < k) notes.push('fewer_paraphrases');

  const [original, ...judged] = await Promise.all([
    judgeWording(criterion, criterion.instructions, sampleCases, judge, options.threshold),
    ...candidates.map((p) => judgeWording(criterion, p, sampleCases, judge, options.threshold)),
  ]);

  const paraphrases: string[] = [];
  const agreement: number[] = [];
  let spread: number | undefined;
  candidates.forEach((text, i) => {
    const byCase = judged[i];
    if (byCase === undefined || original === undefined) return;
    let agree = 0;
    let n = 0;
    for (const c of sampleCases) {
      const before = original.get(c.id);
      const after = byCase.get(c.id);
      const d0 = decision(before);
      const d1 = decision(after);
      if (d0 === undefined || d1 === undefined) continue;
      n += 1;
      if (d0 === d1) agree += 1;
      const p0 = probability(criterion, before?.answer);
      const p1 = probability(criterion, after?.answer);
      if (p0 !== undefined && p1 !== undefined) {
        spread = Math.max(spread ?? 0, Math.abs(p1 - p0));
      }
    }
    if (n === 0) return; // unscored under this paraphrase: excluded
    paraphrases.push(text);
    agreement.push(agree / n);
  });
  if (paraphrases.length < MIN_PARAPHRASES) {
    return paraphraseSkipped('too_few_paraphrases', {
      agreement,
      paraphrases,
      notes,
      ...(spread === undefined ? {} : { spread }),
    });
  }
  const failed = agreement.some((a) => a < minAgreement - EPS);
  return {
    result: failed ? 'fail' : 'pass',
    reasons: failed ? ['paraphrase'] : [],
    agreement,
    ...(spread === undefined ? {} : { spread }),
    paraphrases,
    notes,
  };
}

function polaritySkipped(
  reason: GauntletWordingSkipReason,
  extra: Partial<PolarityResult> = {},
): PolarityResult {
  return { result: 'skipped', reasons: [], reason, ...extra };
}

export async function gauntletPolarity(
  criterion: Criterion,
  sampleCases: readonly Case[],
  labels: readonly CalibrationLabel[],
  generator: GeneratorV1 | undefined,
  judge: JudgeV1,
  options: WordingJudgeOptions = {},
): Promise<PolarityResult> {
  if (criterion.type !== 'boolean') return polaritySkipped('not_boolean');
  if (generator === undefined) return polaritySkipped('no_generator');
  const minAgreement = options.minAgreement ?? DEFAULT_MIN_AGREEMENT;

  const generated = await generate<{ negated: string }>(
    generator,
    NEGATION_SYSTEM,
    `Question: ${criterion.instructions}\nReturn {"negated": "..."}.`,
    'negation',
    NEGATION_SCHEMA,
  );
  if (!generated.ok) return polaritySkipped('bad_generator_output', { cause: generated.cause });
  const negated = generated.value.negated.trim();
  if (!NEGATION.test(negated)) return polaritySkipped('no_negation');
  const negatedHash = createHash('sha256').update(negated).digest('hex');

  const [original, flipped] = await Promise.all([
    judgeWording(criterion, criterion.instructions, sampleCases, judge, options.threshold),
    judgeWording(criterion, negated, sampleCases, judge, options.threshold),
  ]);

  // Remapped labels: a high P(yes) on the negated wording means the original's "no", so the
  // positive class for the negated wording is the original's fail under pass_when_true.
  const positiveOriginal = criterion.polarity === 'pass_when_true' ? 'fail' : 'pass';
  const labelOf = new Map(labels.map((l) => [l.caseId, l.label]));
  const values: number[] = [];
  const isPositive: boolean[] = [];
  for (const c of sampleCases) {
    const label = labelOf.get(c.id);
    const v = flipped.get(c.id);
    const p = v?.status === 'ok' ? probability(criterion, v.answer) : undefined;
    if (label === undefined || label === 'unknown' || p === undefined) continue;
    values.push(p);
    isPositive.push(label === positiveOriginal);
  }
  const negatedThreshold = fitThreshold(values, isPositive);
  if (negatedThreshold === undefined) return polaritySkipped('no_threshold', { negatedHash });

  let agree = 0;
  let n = 0;
  for (const c of sampleCases) {
    const d0 = decision(original.get(c.id));
    const v = flipped.get(c.id);
    let d1: Decision | undefined;
    if (v?.status === 'not_applicable') d1 = 'escape';
    else if (v?.status === 'ok') {
      const p = probability(criterion, v.answer);
      if (p !== undefined) {
        const positive = p >= negatedThreshold - EPS;
        d1 = positive === (positiveOriginal === 'pass') ? 'pass' : 'fail';
      }
    }
    if (d0 === undefined || d1 === undefined) continue;
    n += 1;
    if (d0 === d1) agree += 1;
  }
  if (n === 0) return polaritySkipped('no_comparable_cases', { negatedThreshold, negatedHash });
  const agreement = agree / n;
  const failed = agreement < minAgreement - EPS;
  return {
    result: failed ? 'fail' : 'pass',
    reasons: failed ? ['polarity'] : [],
    agreement,
    negatedThreshold,
    negatedHash,
  };
}
