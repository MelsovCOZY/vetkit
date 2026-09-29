// runEvals: the pipeline `vet run` calls — load criteria and cases, judge every case (runJudge,
// DECISION: core seams named), apply thresholds with polarity and tolerance bands, summarise and
// decide the exit code (gate.ts). Library code emits typed events and never logs.
//
// Pass semantics (DECISION: escape and pass semantics): boolean criteria come back as a 3-way
// choice {yes, no, escape}; p = P(yes), P(escape) >= escapeThreshold gives not_applicable,
// pass = p >= threshold (pass_when_true) or 1-p >= threshold (pass_when_false). Choice passes when
// P(passWhen) = Σ p over the passWhen labels >= threshold (1 − P for pass_when_false). Score passes when the expected level E >= threshold (max − E
// for pass_when_false). Only boolean and choice criteria gate (eval-quality brief §5.2 item 14);
// code-graded criteria never reach the judge.
import {
  CEV_ERROR_CODES,
  VetError,
  type Case,
  type Criterion,
  type JudgeV1,
  type Lock,
  type LockCriterion,
  type Verdict,
} from '@vetkit/spec';
import { loadCases } from './cases/load.ts';
import { createEvents, type EventMap, type Events } from './events.ts';
import { loadCriteria } from './criteria/load.ts';
import { decideExit, evaluateGate, type ExitCode, type GatePolicy } from './gate.ts';
import { createFileCache, type VerdictCache } from './judge/cache.ts';
import { createLimiter, type Limiter, type PacingEvent } from './judge/pacing.ts';
import { gradeCode } from './judge/reference.ts';
import { httpStatusOf, judgeCase } from './judge/request.ts';
import { assertLockGates } from './validate/lock.ts';

/** Uncalibrated placeholder threshold, never trusted for gating (jev brief §5). */
const DEFAULT_THRESHOLD = 0.5;
const DEFAULT_ESCAPE_THRESHOLD = 0.5;
const ESCAPE_KEY = 'escape';
/** Float slack so |p - threshold| == tolerance counts as inside the band. */
const EPSILON = 1e-9;

export interface RunVerdict extends Verdict {
  /** |p - threshold| <= lock tolerance; the verdict is still decided by sign. */
  borderline?: boolean;
  /** The threshold came from a calibrated lock entry. */
  calibrated?: boolean;
}

export type Saturation = 'all_pass' | 'all_fail' | null;

export interface CriterionSummary {
  total: number;
  passed: number;
  failed: number;
  unscored: number;
  saturated: Saturation;
}

export interface RunSummary {
  total: number;
  passed: number;
  failed: number;
  unscored: number;
  aborted: boolean;
  byCriterion: Record<string, CriterionSummary>;
}

/** One event on the gej bus (./events.ts), as a tagged union over EventMap. */
export type RunEvent = {
  readonly [K in keyof EventMap]: { readonly name: K; readonly payload: EventMap[K] };
}[keyof EventMap];

/** The fields runEvals reads; a resolved config object passes through structurally. */
export interface RunConfig {
  readonly criteriaPath: string;
  readonly casesDir: string;
  readonly judge: JudgeV1;
  readonly threshold?: number;
  readonly gate?: boolean;
  /** CI gating: an unpinned (floating) lock refuses with GATE_UNPINNED unless allowUnpinned. */
  readonly ci?: boolean;
  readonly gatePolicy?: Partial<GatePolicy>;
  readonly cacheDir?: string;
}

export interface RunJudgeInput {
  readonly cases: readonly Case[];
  readonly criteria: readonly Criterion[];
  readonly judge: JudgeV1;
  readonly cache?: VerdictCache;
  readonly repeats?: number;
  readonly bypassCache?: boolean;
  readonly signal?: AbortSignal;
  readonly limiter?: Limiter;
  readonly lock?: Lock | null;
  /** Fallback threshold for criteria without a lock threshold (default 0.5, uncalibrated). */
  readonly threshold?: number;
  readonly events?: Events;
}

function codeVerdict(criterion: Criterion, evalCase: Case): Verdict {
  const check = criterion.grader?.kind === 'code' ? criterion.grader.check : 'exact';
  const id = `code:${check}`;
  const base = {
    caseId: evalCase.id,
    criterionId: criterion.id,
    model: { requested: id, resolved: id, transport: 'code', pinned: true },
    cacheHit: false,
  };
  const graded = gradeCode(criterion, evalCase);
  if (graded.status === 'not_applicable') {
    return { ...base, status: 'not_applicable', cause: graded.cause };
  }
  return {
    ...base,
    status: 'ok',
    answer: { type: 'boolean', probability: graded.probability },
    pass: graded.pass,
  };
}

function gateFields(
  criterion: Criterion,
  evalCase: Case,
  entry: LockCriterion | undefined,
): Pick<Verdict, 'gated' | 'gateReason'> {
  if (criterion.type === 'score') return { gated: false, gateReason: 'score_not_gateable' };
  const languages = entry?.languages;
  if (
    languages !== undefined &&
    languages.length > 0 &&
    !languages.includes(evalCase.language ?? 'und')
  ) {
    return { gated: false, gateReason: 'language_not_calibrated' };
  }
  return { gated: true };
}

function escapeKey(criterion: Criterion): string {
  if (criterion.type !== 'choice') return ESCAPE_KEY;
  const escape = String(criterion.escape);
  return Object.hasOwn(criterion.criteria, escape) ? escape : ESCAPE_KEY;
}

const PROV_KEYS = [
  'traceId',
  'spanId',
  'responseId',
  'observationId',
  'dialect',
  'schemaUrl',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The case's correlation ids for sinks. Picks only the six schema keys (verdict provenance is
 * additionalProperties:false, and the outbox re-validates every line); case.traceId wins.
 */
function verdictProvenance(evalCase: Case): Verdict['provenance'] | undefined {
  const source = isRecord(evalCase.provenance) ? evalCase.provenance : {};
  const out: NonNullable<Verdict['provenance']> = {};
  for (const key of PROV_KEYS) {
    const value = source[key];
    if (typeof value === 'string') out[key] = value;
  }
  if (evalCase.traceId !== undefined) out.traceId = evalCase.traceId;
  return Object.keys(out).length === 0 ? undefined : out;
}

/** decideVerdict's own output fields; threshold rides along only with pass/borderline. */
export interface DecideVerdictResult {
  status?: Verdict['status'];
  cause?: unknown;
  pass?: boolean;
  borderline?: boolean;
  threshold?: number;
}

function badResponseResult(): DecideVerdictResult {
  return { status: 'error', cause: CEV_ERROR_CODES.JUDGE_BAD_RESPONSE };
}

/**
 * Pure pass/escape/threshold math for one already-answered (status 'ok', answer defined,
 * non-code-graded) verdict — boolean, choice and score, incl. pass_when_false and the
 * EPSILON-banded borderline. No Case/Lock args: decide() resolves those into threshold/
 * tolerance before calling this. Exported so emitted scorer modules (export-vitest) call the
 * same math instead of duplicating it (root ledger DECISION).
 */
export function decideVerdict(
  verdict: Verdict,
  criterion: Criterion,
  threshold: number,
  tolerance = 0,
): DecideVerdictResult {
  const answer = verdict.answer;
  const escapeThreshold = criterion.escapeThreshold ?? DEFAULT_ESCAPE_THRESHOLD;
  const band = (x: number): boolean => Math.abs(x - threshold) <= tolerance + EPSILON;

  if (criterion.type === 'score') {
    if (answer?.type !== 'score') return badResponseResult();
    // Same pass value calibrate fits on (validate/calibrate.ts repeatValues): the expected level
    // E = Σ level·p (the argmax score when no probabilities come back), or max − E for
    // pass_when_false, where max = levels − 1.
    const entries = Object.entries(answer.probabilities);
    const expected =
      entries.length === 0
        ? answer.score
        : entries.reduce((sum, [level, p]) => sum + Number(level) * p, 0);
    const value =
      criterion.polarity === 'pass_when_false'
        ? criterion.criteria.length - 1 - expected
        : expected;
    return { threshold, pass: value >= threshold, borderline: band(value) };
  }

  if (criterion.type === 'choice') {
    if (answer?.type !== 'choice') return badResponseResult();
    // choice answers resolve the escape label through escapeKey(criterion) (criterion.escape,
    // falling back to 'escape'); see the boolean-answered-as-choice branch below for the
    // asymmetric case.
    const key = escapeKey(criterion);
    if (answer.choice === key || (answer.probabilities[key] ?? 0) >= escapeThreshold) {
      return { status: 'not_applicable', cause: 'escape' };
    }
    // Same pass value calibrate fits on (validate/calibrate.ts repeatValues): P(passWhen) = Σ p
    // over the passWhen labels (the argmax label in passWhen as 1 / 0 when no probabilities come
    // back), or 1 − P(passWhen) for pass_when_false.
    const passWhen = new Set(criterion.passWhen ?? []);
    const entries = Object.entries(answer.probabilities);
    const pPass =
      entries.length === 0
        ? Number(passWhen.has(answer.choice))
        : entries.filter(([label]) => passWhen.has(label)).reduce((sum, [, p]) => sum + p, 0);
    const value = criterion.polarity === 'pass_when_false' ? 1 - pPass : pPass;
    return { threshold, pass: value >= threshold, borderline: band(value) };
  }

  let p: number;
  if (answer?.type === 'boolean') {
    p = answer.probability;
  } else if (answer?.type === 'choice') {
    // Boolean criteria answered choice-shaped (escape) always test the literal ESCAPE_KEY
    // constant, ignoring criterion.escape even though boolean criteria have an escape field
    // (this asymmetry with the choice branch above is intentional,
    // not a bug; do not unify it).
    if ((answer.probabilities[ESCAPE_KEY] ?? 0) >= escapeThreshold) {
      return { status: 'not_applicable', cause: 'escape' };
    }
    p = answer.probabilities['yes'] ?? 0;
  } else {
    return badResponseResult();
  }
  // Thresholds live on the pass-value scale calibrate fits on: P(yes), or 1 − P(yes) for
  // pass_when_false (validate/calibrate.ts repeatValues).
  const value = criterion.polarity === 'pass_when_true' ? p : 1 - p;
  return { threshold, pass: value >= threshold, borderline: band(value) };
}

function decide(
  verdict: Verdict,
  criterion: Criterion,
  evalCase: Case,
  lock: Lock | null,
  fallbackThreshold: number,
): RunVerdict {
  const entry = lock?.criteria[criterion.id];
  const provenance = verdictProvenance(evalCase);
  const base: RunVerdict = {
    ...verdict,
    calibrated: entry?.status === 'calibrated',
    ...gateFields(criterion, evalCase, entry),
    ...(provenance === undefined ? {} : { provenance }),
  };
  if (
    criterion.grader?.kind === 'code' ||
    verdict.status !== 'ok' ||
    verdict.answer === undefined
  ) {
    return base;
  }

  const threshold = entry?.threshold ?? fallbackThreshold;
  const tolerance = entry?.tolerance ?? 0;
  return { ...base, ...decideVerdict(verdict, criterion, threshold, tolerance) };
}

/** Pacing notes (throttle, retry) ride on the diag channel. */
function pacingDiag(events: Events): (event: PacingEvent) => void {
  return (event) => {
    if (event.type === 'judge.throttled') {
      events.diag('warn', 'JUDGE_THROTTLED', 'judge throttled, backing off', {
        retryAfterMs: event.retryAfterMs,
        ceiling: event.ceiling,
      });
    } else {
      events.diag('info', 'JUDGE_RETRY', 'retrying judge request', { attempt: event.attempt });
    }
  };
}

/** HTTP-like status for judge:response: 200 when answered (live or cached), else the error's real
 * HTTP status (httpStatusOf reads it off err.cause.status / the message text,
 * never the body), or 0 when neither is present. */
function statusOf(err: unknown): number {
  return httpStatusOf(err) ?? 0;
}

/** The safe subset of a verdict's cause that may ride the 'verdict' event: status and errorType
 * only, never the VetError code, a body or a key. */
function verdictCause(cause: unknown): EventMap['verdict']['cause'] {
  if (typeof cause !== 'object' || cause === null) return undefined;
  const status = (cause as { status?: unknown }).status;
  const errorType = (cause as { errorType?: unknown }).errorType;
  const out: { status?: number; errorType?: string } = {};
  if (typeof status === 'number') out.status = status;
  if (typeof errorType === 'string') out.errorType = errorType;
  return Object.keys(out).length > 0 ? out : undefined;
}

function markAborted(verdicts: Verdict[]): Verdict[] {
  return verdicts.map((v) => (v.status === 'unscored' ? { ...v, cause: 'aborted' } : v));
}

/** Judges every case (one request per case per repeat) and applies thresholds; never throws on judge failure. */
export async function runJudge(input: RunJudgeInput): Promise<RunVerdict[]> {
  const { judge, signal } = input;
  const events = input.events ?? createEvents();
  const limiter = input.limiter ?? createLimiter({ emit: pacingDiag(events) });
  const lock = input.lock ?? null;
  const fallbackThreshold = input.threshold ?? DEFAULT_THRESHOLD;
  const repeats = Math.max(1, input.repeats ?? 1);
  const cache = input.bypassCache === true ? undefined : input.cache;
  const byId = new Map(input.criteria.map((c) => [c.id, c]));
  const coded = input.criteria.filter((c) => c.grader?.kind === 'code');
  const judged = input.criteria.filter((c) => c.grader?.kind !== 'code');

  // Every doJudge call goes through the shared limiter (pacing leaf); none bypasses it.
  const paced: JudgeV1 = {
    specVersion: judge.specVersion,
    id: judge.id,
    capabilities: judge.capabilities,
    doJudge: (req) =>
      limiter.run(() => judge.doJudge(req), signal === undefined ? undefined : { signal }),
  };

  async function judgeOnce(evalCase: Case): Promise<Verdict[]> {
    const stateBytes = Buffer.byteLength(evalCase.input.state, 'utf8');
    for (const c of judged) {
      events.emit('judge:request', { caseId: evalCase.id, criterionId: c.id, stateBytes });
    }
    // Observes the one doJudge call (absent on a cache hit) for status and token counts only.
    let status = 200;
    let inputTokens: number | undefined;
    const observed: JudgeV1 = {
      ...paced,
      doJudge: async (req) => {
        try {
          const response = await paced.doJudge(req);
          inputTokens = response.usage.inputTokens;
          return response;
        } catch (err) {
          status = statusOf(err);
          throw err;
        }
      },
    };
    const started = performance.now();
    const verdicts = await judgeCase({
      judge: observed,
      case: evalCase,
      criteria: judged,
      ...(cache === undefined ? {} : { cache }),
      ...(signal === undefined ? {} : { signal }),
    });
    const durationMs = Math.round(performance.now() - started);
    for (const v of verdicts) {
      events.emit('judge:response', {
        caseId: v.caseId,
        criterionId: v.criterionId,
        status: v.status === 'unscored' && status === 200 ? 0 : status,
        durationMs,
        ...(inputTokens === undefined ? {} : { inputTokens }),
        cacheHit: v.cacheHit,
      });
    }
    return signal?.aborted === true ? markAborted(verdicts) : verdicts;
  }

  async function perCase(evalCase: Case, index: number): Promise<RunVerdict[]> {
    events.emit('case:start', { caseId: evalCase.id, index, total: input.cases.length });
    const raw = coded.map((c) => codeVerdict(c, evalCase));
    if (judged.length > 0) {
      const runs = await Promise.all(Array.from({ length: repeats }, () => judgeOnce(evalCase)));
      raw.push(...runs.flat());
    }
    const out = raw.flatMap((v) => {
      const criterion = byId.get(v.criterionId);
      return criterion === undefined
        ? []
        : [decide(v, criterion, evalCase, lock, fallbackThreshold)];
    });
    for (const v of out) {
      const cause = v.status === 'unscored' ? verdictCause(v.cause) : undefined;
      events.emit('verdict', {
        caseId: v.caseId,
        criterionId: v.criterionId,
        status: v.status,
        ...(v.pass === undefined ? {} : { pass: v.pass }),
        ...(cause === undefined ? {} : { cause }),
      });
    }
    return out;
  }

  const results = await Promise.all(input.cases.map(perCase));
  return results.flat();
}

type Outcome = 'passed' | 'failed' | 'unscored' | 'neutral';

function outcome(v: Verdict): Outcome {
  if (v.status === 'not_applicable') return 'neutral';
  if (v.status !== 'ok') return 'unscored';
  return v.pass === true ? 'passed' : 'failed';
}

function summarise(
  cases: readonly Case[],
  criteria: readonly Criterion[],
  verdicts: readonly RunVerdict[],
  aborted: boolean,
): RunSummary {
  const summary: RunSummary = {
    total: cases.length,
    passed: 0,
    failed: 0,
    unscored: 0,
    aborted,
    byCriterion: {},
  };
  for (const evalCase of cases) {
    const outcomes = verdicts.filter((v) => v.caseId === evalCase.id).map(outcome);
    // A case with no verdicts at all (e.g. the gate refused before any judge call) was never
    // scored — it must not default to "passed", or summary.passed drifts from results: [].
    if (outcomes.includes('failed')) summary.failed += 1;
    else if (outcomes.length === 0 || outcomes.includes('unscored')) summary.unscored += 1;
    else summary.passed += 1;
  }
  for (const criterion of criteria) {
    const outcomes = verdicts.filter((v) => v.criterionId === criterion.id).map(outcome);
    const passed = outcomes.filter((o) => o === 'passed').length;
    const failed = outcomes.filter((o) => o === 'failed').length;
    let saturated: Saturation = null;
    if (passed + failed > 0) {
      if (failed === 0) saturated = 'all_pass';
      else if (passed === 0) saturated = 'all_fail';
    }
    summary.byCriterion[criterion.id] = {
      total: outcomes.length,
      passed,
      failed,
      unscored: outcomes.filter((o) => o === 'unscored').length,
      saturated,
    };
  }
  return summary;
}

export interface RunEvalsInput {
  readonly config: RunConfig;
  readonly signal?: AbortSignal;
  /** Parsed lock, or null when none exists (lock reading lands in J3). */
  readonly lock?: Lock | null;
  readonly limiter?: Limiter;
  readonly events?: Events;
}

export interface RunEvalsResult {
  results: RunVerdict[];
  summary: RunSummary;
  model: Verdict['model'];
  exitCode: ExitCode;
  /** Why the gate refused (exit 2); names the criterion or transport. */
  gateReasons: string[];
}

function loadError(
  code: VetError['code'],
  source: string,
  issues: readonly { message: string }[],
): VetError {
  const detail = issues.map((i) => i.message).join('; ');
  return new VetError(code, `cannot load ${source}: ${detail}`);
}

function runModel(verdicts: readonly Verdict[], judge: JudgeV1): Verdict['model'] {
  const judged = verdicts.find((v) => v.model.transport !== 'code' && v.model.resolved !== '');
  if (judged !== undefined) return judged.model;
  const { model, transport, pinned } = judge.capabilities;
  return { requested: model, resolved: '', transport, pinned };
}

function preJudgeRefusal(
  config: RunConfig,
  lock: Lock | null,
  criteria: readonly Criterion[],
): string | undefined {
  if (config.gate !== true && config.ci !== true) return undefined;
  if (lock === null) {
    if (config.gate !== true) return undefined;
    return evaluateGate({
      verdicts: [],
      lock,
      policy: { requireCalibrated: true, allowUnpinned: true },
    }).reasons.join('; ');
  }
  const checked = assertLockGates(
    lock,
    { requireCalibrated: config.gatePolicy?.requireCalibrated ?? true },
    {
      gate: config.gate === true,
      ci: config.ci === true,
      allowUnpinned: config.gatePolicy?.allowUnpinned ?? false,
      criterionIds: criteria.filter((c) => c.type !== 'score').map((c) => c.id),
    },
  );
  return checked.ok ? undefined : `${checked.code}: ${checked.message}`;
}

function disabledVerdicts(
  cases: readonly Case[],
  disabled: readonly Criterion[],
  judge: JudgeV1,
): RunVerdict[] {
  const { model, transport, pinned } = judge.capabilities;
  return cases.flatMap((evalCase) =>
    disabled.map((criterion) => {
      const provenance = verdictProvenance(evalCase);
      return {
        caseId: evalCase.id,
        criterionId: criterion.id,
        status: 'not_applicable' as const,
        cause: 'disabled',
        model: { requested: model, resolved: '', transport, pinned },
        cacheHit: false,
        gated: false,
        ...(provenance === undefined ? {} : { provenance }),
      };
    }),
  );
}

export async function runEvals(input: RunEvalsInput): Promise<RunEvalsResult> {
  const { config, signal } = input;
  const events = input.events ?? createEvents();
  const lock = input.lock ?? null;
  const started = performance.now();

  const loadedCriteria = await loadCriteria(config.criteriaPath);
  if (!loadedCriteria.ok) {
    const code = loadedCriteria.issues[0]?.code ?? CEV_ERROR_CODES.CRITERIA_INVALID;
    throw loadError(code, config.criteriaPath, loadedCriteria.issues);
  }
  const loadedCases = await loadCases(config.casesDir);
  if (!loadedCases.ok) {
    const code = loadedCases.issues[0]?.code ?? CEV_ERROR_CODES.CASE_INVALID;
    throw loadError(code, config.casesDir, loadedCases.issues);
  }
  const { criteria } = loadedCriteria;
  const { cases } = loadedCases;
  // `enabled: false` (vet criteria disable): never judged, never gated, reported not_applicable.
  const active = criteria.filter((c) => c.enabled !== false);
  const disabled = criteria.filter((c) => c.enabled === false);

  events.emit('run:start', { cases: cases.length, criteria: criteria.length });
  if (cases.length === 0) events.diag('warn', 'NO_CASES', 'no cases to judge');
  if (!active.some((c) => c.type === 'boolean' || c.type === 'choice')) {
    events.diag('warn', 'NO_GATEABLE_CRITERIA', 'no boolean or choice criterion can gate');
  }

  // The gate refuses before any judge call: no lock, an unpinned lock under --ci, or a
  // referenced boolean/choice criterion that is not gateable in the lock.
  const refusal = preJudgeRefusal(config, lock, active);
  if (refusal !== undefined) {
    events.emit('run:end', {
      cases: cases.length,
      verdicts: 0,
      exitCode: 2,
      durationMs: Math.round(performance.now() - started),
    });
    return {
      results: [],
      summary: summarise(cases, criteria, [], false),
      model: runModel([], config.judge),
      exitCode: 2,
      gateReasons: [refusal],
    };
  }

  const judged = await runJudge({
    cases,
    criteria: active,
    judge: config.judge,
    lock,
    events,
    ...(config.cacheDir === undefined ? {} : { cache: createFileCache(config.cacheDir) }),
    ...(config.threshold === undefined ? {} : { threshold: config.threshold }),
    ...(input.limiter === undefined ? {} : { limiter: input.limiter }),
    ...(signal === undefined ? {} : { signal }),
  });

  const results = [...judged, ...disabledVerdicts(cases, disabled, config.judge)];
  const aborted = signal?.aborted === true;
  const summary = summarise(cases, criteria, results, aborted);
  for (const [criterionId, s] of Object.entries(summary.byCriterion)) {
    if (s.saturated !== null) {
      events.diag('info', 'CRITERION_SATURATED', `criterion ${criterionId} is ${s.saturated}`, {
        passed: s.passed,
        failed: s.failed,
      });
    }
  }

  let exitCode: ExitCode;
  let gateReasons: string[] = [];
  const minPass = config.gatePolicy?.minPass;
  if (aborted) {
    exitCode = 130;
  } else if (config.gate === true) {
    const gate = evaluateGate({
      verdicts: results,
      lock,
      policy: {
        requireCalibrated: config.gatePolicy?.requireCalibrated ?? true,
        allowUnpinned: config.gatePolicy?.allowUnpinned ?? false,
        ...(minPass === undefined ? {} : { minPass }),
      },
    });
    exitCode = gate.exitCode;
    gateReasons = gate.reasons;
  } else {
    exitCode = decideExit(
      minPass === undefined ? { verdicts: results } : { verdicts: results, minPass },
    );
  }

  events.emit('run:end', {
    cases: cases.length,
    verdicts: results.length,
    exitCode,
    durationMs: Math.round(performance.now() - started),
  });
  return { results, summary, model: runModel(results, config.judge), exitCode, gateReasons };
}
