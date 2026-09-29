// criteria.lock.json: the only artifact allowed to gate. buildLock folds the
// calibrate and gauntlet results into per-criterion status + reasons; writeLockAtomic writes it
// through a temp file and rename; readLock validates it against lockSchema; checkLock recomputes
// the content hashes of questions and dataset; assertLockGates is the pre-judge refusal
// `vet run --gate/--ci` applies (alias locks are floating and never gate CI without
// --allow-unpinned).
//
// Floating rule: an unpinned model turns only entries that would
// otherwise be calibrated into `floating`; failing entries stay `uncalibrated`.
import { createHash, randomBytes } from 'node:crypto';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  CEV_ERROR_CODES,
  lockSchema,
  safeParseJson,
  VetError,
  type Case,
  type Criterion,
  type GauntletOutcome,
  type GauntletResult,
  type JudgeResponse,
  type Lock,
  type LockCriterion,
  type LockModel,
  type LockReason,
} from '@vetkit/spec';
import { computeWordingHash } from '../criteria/load.ts';
import { computeNormalizedWordingHash, wordingOf } from '../criteria/wording.ts';
import type { Events } from '../events.ts';
import type { GatePolicy } from '../gate.ts';
import { referenceRequirement } from '../judge/reference.ts';
import type { CalibrationResult } from './calibrate.ts';

const MIN_LABELS = 100;
export const LOCK_FILE = 'criteria.lock.json';

const GAUNTLET_KEYS = [
  'paraphrase',
  'polarity',
  'injection',
  'master_key',
  'label_permutation',
  'constant_output',
  'position_swap',
  'length',
] as const satisfies readonly (keyof GauntletResult)[];

// LockReason enum order (lock.schema.json); reasons are written in this order.
const REASON_ORDER: readonly LockReason[] = [
  'too_few_labels',
  'single_class',
  'single_class_heldout',
  'class_too_small',
  'unstable',
  'too_few_repeats',
  'language_limited',
  'score_not_gateable',
  'reference_missing',
  'judge_unavailable',
  ...GAUNTLET_KEYS,
];

/** Unscored fraction above which the lock blames the judge instead of the data. */
const UNAVAILABLE_ABOVE = 0.1;

export interface Unscored {
  readonly count: number;
  readonly total: number;
  readonly causes: string[];
}

/** Code of a verdict cause: a bare code string or `{code}`; never the rest of the cause. */
function causeCode(cause: unknown): string {
  if (typeof cause === 'string') return cause;
  if (typeof cause === 'object' && cause !== null) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return 'UNKNOWN';
}

/** Unscored verdicts of one criterion: count, total, and the sorted distinct cause codes. */
export function unscoredOf(
  criterionId: string,
  verdicts: readonly {
    readonly criterionId: string;
    readonly status: string;
    readonly cause?: unknown;
  }[],
): Unscored {
  const own = verdicts.filter((v) => v.criterionId === criterionId);
  const failed = own.filter((v) => v.status !== 'ok');
  return {
    count: failed.length,
    total: own.length,
    causes: [...new Set(failed.map((v) => causeCode(v.cause)))].toSorted(),
  };
}

/** True when more than 10% of a criterion's verdicts are unscored. */
export function judgeUnavailable(unscored: Unscored | undefined): boolean {
  return (
    unscored !== undefined &&
    unscored.total > 0 &&
    unscored.count / unscored.total > UNAVAILABLE_ABOVE
  );
}

export interface LockCriterionInput {
  /** Unscored verdict tally; over 10% unscored replaces the data-shape reasons with judge_unavailable. */
  readonly unscored?: Unscored;
  readonly calibration: CalibrationResult;
  /** A missing key is recorded as skipped. */
  readonly gauntlet: Partial<Record<keyof GauntletResult, GauntletOutcome>>;
}

export interface LockInputs {
  readonly model: JudgeResponse['model'];
  readonly criteria: readonly Criterion[];
  readonly cases: readonly Case[];
  readonly results: Readonly<Record<string, LockCriterionInput>>;
}

function lockModel(model: JudgeResponse['model']): LockModel {
  return {
    requested: model.requested,
    resolved: model.resolved,
    transport: model.transport,
    pinned: model.pinned,
    ...(model.releaseDate === undefined ? {} : { releaseDate: model.releaseDate }),
  };
}

function entryFor(
  criterion: Criterion,
  input: LockCriterionInput | undefined,
  cases: readonly Case[],
  pinned: boolean,
): LockCriterion {
  const cal = input?.calibration;
  const unavailable = judgeUnavailable(input?.unscored);
  const reasons = new Set<LockReason>(cal?.reasons ?? []);
  const labelCount = cal?.labelCount ?? 0;
  if (labelCount < MIN_LABELS) reasons.add('too_few_labels');

  const code = criterion.grader?.kind === 'code';
  const outcome = (key: keyof GauntletResult): GauntletOutcome =>
    code ? 'skipped' : (input?.gauntlet[key] ?? 'skipped');
  const gauntlet: GauntletResult = {
    paraphrase: outcome('paraphrase'),
    polarity: outcome('polarity'),
    injection: outcome('injection'),
    master_key: outcome('master_key'),
    label_permutation: outcome('label_permutation'),
    constant_output: outcome('constant_output'),
    position_swap: outcome('position_swap'),
    length: outcome('length'),
  };
  if (!code) for (const key of GAUNTLET_KEYS) if (gauntlet[key] !== 'pass') reasons.add(key);
  if (criterion.type === 'score') reasons.add('score_not_gateable');
  if (!referenceRequirement(criterion, [...cases]).ok) reasons.add('reference_missing');

  if (unavailable) reasons.add('judge_unavailable');
  const blocking = [...reasons].filter((r) => r !== 'language_limited');
  const ok = cal?.status === 'calibrated' && blocking.length === 0;
  let status: LockCriterion['status'] = 'uncalibrated';
  if (ok) status = pinned ? 'calibrated' : 'floating';

  return {
    wordingHash: criterion.wordingHash,
    normalizedWordingHash: computeNormalizedWordingHash(wordingOf(criterion)),
    status,
    ...(cal?.threshold === undefined ? {} : { threshold: cal.threshold }),
    ...(cal?.tpr === undefined ? {} : { tpr: cal.tpr }),
    ...(cal?.tnr === undefined ? {} : { tnr: cal.tnr }),
    ...(cal?.ece === undefined ? {} : { ece: cal.ece }),
    ...(cal?.tolerance === undefined ? {} : { tolerance: cal.tolerance }),
    gauntlet,
    // The judge outage replaces the data-shape reasons its unscored verdicts would otherwise produce.
    reasons: unavailable ? ['judge_unavailable'] : REASON_ORDER.filter((r) => reasons.has(r)),
    ...(cal === undefined ? {} : { languages: [...cal.languages] }),
    labelCount,
    ...(input?.unscored === undefined || input.unscored.count === 0
      ? {}
      : { unscored: input.unscored.count, unscoredCauses: [...input.unscored.causes] }),
  };
}

export function buildLock(inputs: LockInputs): Lock {
  const criteria: Record<string, LockCriterion> = {};
  for (const c of inputs.criteria) {
    criteria[c.id] = entryFor(c, inputs.results[c.id], inputs.cases, inputs.model.pinned);
  }
  return {
    lockVersion: 1,
    model: lockModel(inputs.model),
    criteria,
    datasetHash: datasetHash(inputs.cases),
  };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonical(v)]),
    );
  }
  return value;
}

/** sha256 over cases sorted by id, each as canonical JSON of {id, input, expected, language, cluster}. */
export function datasetHash(cases: readonly Case[]): string {
  const hash = createHash('sha256');
  const sorted = cases.toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const c of sorted) {
    const { id, input, expected, language, cluster } = c;
    hash.update(`${JSON.stringify(canonical({ id, input, expected, language, cluster }))}\n`);
  }
  return hash.digest('hex');
}

export interface WriteLockOptions {
  readonly events?: Events;
  /** Epoch ms this validate run started; a target modified after it was written by someone else. */
  readonly since?: number;
}

/** Writes `<path>.<pid>.<rand>.tmp` beside the target, then renames it over; last writer wins. */
export async function writeLockAtomic(
  path: string,
  lock: Lock,
  options: WriteLockOptions = {},
): Promise<void> {
  if (options.since !== undefined) {
    const mtime = await stat(path).then(
      (s) => s.mtimeMs,
      () => undefined,
    );
    if (mtime !== undefined && mtime > options.since) {
      options.events?.diag(
        'warn',
        'LOCK_OVERWRITTEN',
        `${basename(path)} changed while vet validate ran; overwriting it (last writer wins)`,
      );
    }
  }
  const tmp = join(
    dirname(path),
    `${basename(path)}.${String(process.pid)}.${randomBytes(4).toString('hex')}.tmp`,
  );
  try {
    await writeFile(tmp, `${JSON.stringify(lock, null, 2)}\n`);
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

export async function readLock(path: string): Promise<Lock | { error: VetError }> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return {
      error: new VetError(
        CEV_ERROR_CODES.CONFIG_INVALID,
        `no lock at ${path}; run \`vet validate\` to write ${LOCK_FILE}`,
      ),
    };
  }
  const parsed = safeParseJson<Lock>(text, lockSchema);
  return parsed.ok ? parsed.value : { error: parsed.error };
}

/** Missing lock → null; an unreadable or invalid one throws. */
export async function readLockOrNull(path: string): Promise<Lock | null> {
  const exists = await stat(path).then(
    () => true,
    () => false,
  );
  if (!exists) return null;
  const read = await readLock(path);
  if ('error' in read) throw read.error;
  return read;
}

export type StaleReason = 'wordingHash' | 'datasetHash' | 'releaseDate' | 'transport';

export interface CheckLockCurrent {
  readonly criteria: readonly Criterion[];
  readonly cases: readonly Case[];
  /** The judge in use now; releaseDate null or absent means unknown (never stale). */
  readonly model?: { readonly transport: string; readonly releaseDate?: string | null };
}

export interface StaleReport {
  readonly stale: boolean;
  readonly reasons: StaleReason[];
  /** Criterion ids whose wording differs from, or is missing in, the lock. */
  readonly criteria: string[];
  readonly releaseDate: 'match' | 'differs' | 'unknown';
}

export function checkLock(lock: Lock, current: CheckLockCurrent): StaleReport {
  const reasons: StaleReason[] = [];
  const changed = current.criteria
    .filter((c) => lock.criteria[c.id]?.wordingHash !== computeWordingHash(wordingOf(c)))
    .map((c) => c.id);
  if (changed.length > 0) reasons.push('wordingHash');
  if (datasetHash(current.cases) !== lock.datasetHash) reasons.push('datasetHash');

  const now = current.model?.releaseDate ?? undefined;
  const then = lock.model.releaseDate;
  let releaseDate: StaleReport['releaseDate'] = 'unknown';
  if (now !== undefined && then !== undefined) releaseDate = now === then ? 'match' : 'differs';
  if (releaseDate === 'differs') reasons.push('releaseDate');
  if (current.model !== undefined && current.model.transport !== lock.model.transport) {
    reasons.push('transport');
  }
  return { stale: reasons.length > 0, reasons, criteria: changed, releaseDate };
}

/** The one rule both the pre-judge assertion and evaluateGate use. */
export function lockEntryGateable(
  entry: LockCriterion | undefined,
  allowUnpinned: boolean,
): boolean {
  return entry?.status === 'calibrated' || (allowUnpinned && entry?.status === 'floating');
}

export interface LockGateFlags {
  readonly gate?: boolean;
  readonly ci?: boolean;
  readonly allowUnpinned?: boolean;
  /** Criteria the gate policy references (boolean/choice criteria in criteria.yaml). */
  readonly criterionIds: readonly string[];
}

export type LockGateResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: 'GATE_UNCALIBRATED' | 'GATE_UNPINNED';
      readonly criterionId?: string;
      readonly message: string;
    };

export function assertLockGates(
  lock: Lock,
  policy: Pick<GatePolicy, 'minPass' | 'requireCalibrated'>,
  flags: LockGateFlags,
): LockGateResult {
  const allowUnpinned = flags.allowUnpinned === true;
  if (flags.ci === true && !lock.model.pinned && !allowUnpinned) {
    return {
      ok: false,
      code: CEV_ERROR_CODES.GATE_UNPINNED,
      message: `${LOCK_FILE} was written against unpinned transport '${lock.model.transport}'; CI gating refuses it (pass --allow-unpinned to gate anyway)`,
    };
  }
  if (flags.gate === true && policy.requireCalibrated) {
    for (const id of flags.criterionIds.toSorted()) {
      const entry = lock.criteria[id];
      if (lockEntryGateable(entry, allowUnpinned)) continue;
      const status = entry?.status ?? 'missing';
      return {
        ok: false,
        code: CEV_ERROR_CODES.GATE_UNCALIBRATED,
        criterionId: id,
        message: `criterion '${id}' is not calibrated in ${LOCK_FILE} (status ${status}); run \`vet validate\``,
      };
    }
  }
  return { ok: true };
}
