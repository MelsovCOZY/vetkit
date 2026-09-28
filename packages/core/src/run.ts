// runEvals: the pipeline `vet run` calls — load criteria and cases, judge every case (runJudge,
// DECISION: core seams named), apply thresholds with polarity and tolerance bands, summarise and
// decide the exit code (gate.ts). Library code emits typed events and never logs.
//
// Pass semantics (DECISION: escape and pass semantics): boolean criteria come back as a 3-way
// choice {yes, no, escape}; p = P(yes), P(escape) >= escapeThreshold gives not_applicable,
// pass = p >= threshold (pass_when_true) or 1-p >= threshold (pass_when_false). Choice passes when
// the chosen label is in passWhen. Score passes when score >= threshold. Only boolean and choice
// criteria gate (eval-quality brief §5.2 item 14); code-graded criteria never reach the judge.
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
import { judgeCase } from './judge/request.ts';
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
  if (languages !== undefined && !languages.includes(evalCase.language ?? 'und')) {
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

function badResponse(verdict: RunVerdict): RunVerdict {
  return { ...verdict, status: 'error', cause: CEV_ERROR_CODES.JUDGE_BAD_RESPONSE };
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
  const answer = verdict.answer;
  if (criterion.grader?.kind === 'code' || verdict.status !== 'ok' || answer === undefined) {
    return base;
  }

  const threshold = entry?.threshold ?? fallbackThreshold;
  const tolerance = entry?.tolerance ?? 0;
  const escapeThreshold = criterion.escapeThreshold ?? DEFAULT_ESCAPE_THRESHOLD;
  const band = (x: number): boolean => Math.abs(x - threshold) <= tolerance + EPSILON;

  if (criterion.type === 'score') {
    if (answer.type !== 'score') return badResponse(base);
    return {
      ...base,
      threshold,
      pass: answer.score >= threshold,
      borderline: band(answer.score),
    };
  }

  if (criterion.type === 'choice') {
    if (answer.type !== 'choice') return badResponse(base);
    const key = escapeKey(criterion);
    if (answer.choice === key || (answer.probabilities[key] ?? 0) >= escapeThreshold) {
      return { ...base, status: 'not_applicable', cause: 'escape' };
    }
    return { ...base, pass: (criterion.passWhen ?? []).includes(answer.choice) };
  }

  let p: number;
  if (answer.type === 'boolean') {
    p = answer.probability;
  } else if (answer.type === 'choice') {
    if ((answer.probabilities[ESCAPE_KEY] ?? 0) >= escapeThreshold) {
      return { ...base, status: 'not_applicable', cause: 'escape' };
    }
    p = answer.probabilities['yes'] ?? 0;
  } else {
    return badResponse(base);
  }
  // Thresholds live on the pass-value scale calibrate fits on: P(yes), or 1 − P(yes) for
  // pass_when_false (validate/calibrate.ts repeatValues).
  const value = criterion.polarity === 'pass_when_true' ? p : 1 - p;
  return { ...base, threshold, pass: value >= threshold, borderline: band(value) };
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

/** HTTP-like status for judge:response: 200 when answered (live or cached), else the error's status or 0. */
function statusOf(err: unknown): number {
  if (
    typeof err === 'object' &&
    err !== null &&
    'status' in err &&
    typeof err.status === 'number'
  ) {
    return err.status;
  }
  return 0;
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
      events.emit('verdict', {
        caseId: v.caseId,
        criterionId: v.criterionId,
        status: v.status,
        ...(v.pass === undefined ? {} : { pass: v.pass }),
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
    if (outcomes.includes('failed')) summary.failed += 1;
    else if (outcomes.includes('unscored')) summary.unscored += 1;
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

  events.emit('run:start', { cases: cases.length, criteria: criteria.length });
  if (cases.length === 0) events.diag('warn', 'NO_CASES', 'no cases to judge');
  if (!criteria.some((c) => c.type === 'boolean' || c.type === 'choice')) {
    events.diag('warn', 'NO_GATEABLE_CRITERIA', 'no boolean or choice criterion can gate');
  }

  // The gate refuses before any judge call (q4q.11): no lock, an unpinned lock under --ci, or a
  // referenced boolean/choice criterion that is not gateable in the lock.
  const refusal = preJudgeRefusal(config, lock, criteria);
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

  const results = await runJudge({
    cases,
    criteria,
    judge: config.judge,
    lock,
    events,
    ...(config.cacheDir === undefined ? {} : { cache: createFileCache(config.cacheDir) }),
    ...(config.threshold === undefined ? {} : { threshold: config.threshold }),
    ...(input.limiter === undefined ? {} : { limiter: input.limiter }),
    ...(signal === undefined ? {} : { signal }),
  });

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
