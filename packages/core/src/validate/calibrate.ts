// Calibration statistics for one criterion: seeded 50/50 split by case-id hash, threshold fit on
// train (balanced accuracy, 2-decimal grid), TPR/TNR/κ (α ordinal + Kendall τ for score), ECE
// (report-only), repeat tolerance, band cases, per-language slices, clustered SEs and a
// Rogan-Gladen corrected pass rate. Pure functions, no I/O. Expected failures are returned as
// status/reasons, never thrown. Undefined metrics are omitted (the lock never stores null).
import type { Case, Criterion, JudgeResponse, LockReason } from '@vetkit/spec';
import { clusteredSE, clusterKeys } from './clusters.ts';

/** Held-out floor per class (eval-quality brief §5.2 item 3, vetkit choice §5.3). */
const CLASS_FLOOR = 30;
const MIN_LABELS = 100;
const MIN_REPEATS = 3;
/** Per-language Cohen κ floor (vetkit choice, brief §5.3). */
const KAPPA_FLOOR = 0.6;
/** The API rounds probabilities to 2 decimals, so no tolerance can be finer than this. */
const TOLERANCE_FLOOR = 0.02;
const UNSTABLE_AT = 0.25;
const ECE_BINS = 10;
const EPS = 1e-9;

export interface CalibrationLabel {
  readonly caseId: string;
  readonly label: 'pass' | 'fail' | 'unknown';
}

export interface Confusion {
  readonly tp: number;
  readonly fn: number;
  readonly tn: number;
  readonly fp: number;
}

export interface ReliabilityBin {
  readonly lo: number;
  readonly hi: number;
  readonly n: number;
  /** Omitted when the bin is empty. */
  readonly meanP?: number;
  readonly fracPass?: number;
}

export interface LanguageSlice {
  readonly labelCount: number;
  readonly tpr?: number;
  readonly tnr?: number;
  readonly kappa?: number;
  readonly status: 'calibrated' | 'uncalibrated';
  readonly reasons: LockReason[];
}

export interface CalibrationResult {
  readonly threshold?: number;
  readonly tpr?: number;
  readonly tnr?: number;
  readonly se: { readonly tpr?: number; readonly tnr?: number };
  readonly ece?: number;
  readonly reliability: ReliabilityBin[];
  /** Cohen κ on held-out decisions (boolean, choice). */
  readonly kappa?: number;
  /** Krippendorff α (ordinal) on held-out decisions (score). */
  readonly alpha?: number;
  /** Kendall τ-b between the held-out expected value and the label (score). */
  readonly kendallTau?: number;
  readonly tolerance?: number;
  readonly heldOut: Confusion;
  readonly split: { readonly train: string[]; readonly heldOut: string[] };
  readonly byLanguage: Record<string, LanguageSlice>;
  readonly languages: string[];
  readonly status: 'calibrated' | 'uncalibrated';
  readonly reasons: LockReason[];
  /** All label rows, `unknown` included. */
  readonly labelCount: number;
}

export interface CalibrateOptions {
  readonly seed?: number;
}

function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * Deterministic 50/50 split: each id goes to held-out when the top bit of hash(seed:id) is set.
 * Per-id, so adding labels never moves an existing case across the split.
 */
export function splitByHash(
  ids: readonly string[],
  seed = 0,
): { train: string[]; heldOut: string[] } {
  const train: string[] = [];
  const heldOut: string[] = [];
  for (const id of ids) {
    if (fnv1a(`${seed}:${id}`) >= 0x80000000) heldOut.push(id);
    else train.push(id);
  }
  return { train, heldOut };
}

function scoreMax(criterion: Criterion): number {
  return criterion.type === 'score' ? criterion.criteria.length - 1 : 1;
}

/**
 * Per-case pass values, one per repeat: P(pass) for boolean/choice, the expected level for score.
 * `pass_when_false` inverts (1 − p, or max − E). Repeats without an answer for the criterion are
 * skipped.
 */
export function repeatValues(
  criterion: Criterion,
  repeats: ReadonlyMap<string, readonly JudgeResponse[]>,
): Map<string, number[]> {
  const max = scoreMax(criterion);
  const passWhen = new Set(criterion.passWhen ?? []);
  const out = new Map<string, number[]>();
  for (const [caseId, responses] of repeats) {
    const values: number[] = [];
    for (const response of responses) {
      const answer = response.answers[criterion.id];
      let v: number | undefined;
      if (answer?.type === 'boolean') v = answer.probability;
      else if (answer?.type === 'choice') {
        v = Object.entries(answer.probabilities)
          .filter(([key]) => passWhen.has(key))
          .reduce((sum, [, p]) => sum + p, 0);
      } else if (answer?.type === 'score') {
        const entries = Object.entries(answer.probabilities);
        v =
          entries.length === 0
            ? answer.score
            : entries.reduce((sum, [level, p]) => sum + Number(level) * p, 0);
      }
      if (v === undefined || !Number.isFinite(v)) continue;
      values.push(criterion.polarity === 'pass_when_false' ? max - v : v);
    }
    out.set(caseId, values);
  }
  return out;
}

function mean(values: readonly number[]): number {
  return values.reduce((s, v) => s + v, 0) / values.length;
}

/**
 * Max over cases of the spread (max − min) across repeats, rounded up to 0.01, floor 0.02.
 * Undefined when no case has a value.
 */
export function repeatTolerance(
  values: ReadonlyMap<string, readonly number[]>,
): number | undefined {
  let spread: number | undefined;
  for (const vs of values.values()) {
    if (vs.length === 0) continue;
    const s = Math.max(...vs) - Math.min(...vs);
    spread = spread === undefined ? s : Math.max(spread, s);
  }
  if (spread === undefined) return undefined;
  return Math.max(TOLERANCE_FLOOR, Math.ceil(spread * 100 - 1e-6) / 100);
}

/** Case ids whose mean value lies within threshold ± tolerance (inclusive). */
export function bandCases(
  values: ReadonlyMap<string, readonly number[]>,
  threshold: number,
  tolerance: number,
): string[] {
  const out: string[] = [];
  for (const [caseId, vs] of values) {
    if (vs.length === 0) continue;
    if (Math.abs(mean(vs) - threshold) <= tolerance + EPS) out.push(caseId);
  }
  return out;
}

/**
 * Threshold on the 0.01 grid over [0, max] maximising balanced accuracy (predict pass when
 * value ≥ t). Ties resolve to the median grid point of the tied set. Undefined when a class is
 * missing.
 */
export function fitThreshold(
  values: readonly number[],
  isPass: readonly boolean[],
  max = 1,
): number | undefined {
  const pos = isPass.filter(Boolean).length;
  const neg = isPass.length - pos;
  if (pos === 0 || neg === 0) return undefined;
  const steps = Math.round(max * 100);
  let best = -1;
  let tied: number[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / 100;
    let tp = 0;
    let tn = 0;
    values.forEach((v, j) => {
      const predicted = v >= t - EPS;
      if (isPass[j] === true && predicted) tp += 1;
      if (isPass[j] === false && !predicted) tn += 1;
    });
    const ba = (tp / pos + tn / neg) / 2;
    if (ba > best + EPS) {
      best = ba;
      tied = [t];
    } else if (Math.abs(ba - best) <= EPS) tied.push(t);
  }
  return tied[Math.floor((tied.length - 1) / 2)];
}

function ratio(num: number, den: number): number | undefined {
  return den === 0 ? undefined : num / den;
}

function cohenKappa(c: Confusion): number | undefined {
  const n = c.tp + c.fn + c.tn + c.fp;
  if (n === 0) return undefined;
  const po = (c.tp + c.tn) / n;
  const pe = ((c.tp + c.fn) * (c.tp + c.fp) + (c.tn + c.fp) * (c.tn + c.fn)) / (n * n);
  return pe === 1 ? undefined : (po - pe) / (1 - pe);
}

/**
 * Krippendorff α with the ordinal metric for pairs of ratings (two coders, no missing values).
 * Undefined when there is no expected disagreement.
 */
export function krippendorffAlphaOrdinal(
  pairs: readonly (readonly [number, number])[],
): number | undefined {
  const cats = [...new Set(pairs.flat())].toSorted((a, b) => a - b);
  const index = new Map(cats.map((c, i) => [c, i]));
  const k = cats.length;
  const o = Array.from({ length: k }, () => Array.from<number>({ length: k }).fill(0));
  for (const [a, b] of pairs) {
    const i = index.get(a) ?? 0;
    const j = index.get(b) ?? 0;
    const rowI = o[i];
    const rowJ = o[j];
    if (rowI) rowI[j] = (rowI[j] ?? 0) + 1;
    if (rowJ) rowJ[i] = (rowJ[i] ?? 0) + 1;
  }
  const nc = o.map((row) => row.reduce((s, v) => s + v, 0));
  const n = nc.reduce((s, v) => s + v, 0);
  const delta = (c: number, d: number): number => {
    const [lo, hi] = c <= d ? [c, d] : [d, c];
    let sum = 0;
    for (let g = lo; g <= hi; g += 1) sum += nc[g] ?? 0;
    return (sum - ((nc[c] ?? 0) + (nc[d] ?? 0)) / 2) ** 2;
  };
  let observed = 0;
  let expected = 0;
  for (let c = 0; c < k; c += 1) {
    for (let d = 0; d < k; d += 1) {
      const dd = delta(c, d);
      observed += (o[c]?.[d] ?? 0) * dd;
      expected += (nc[c] ?? 0) * (nc[d] ?? 0) * dd;
    }
  }
  if (expected === 0) return undefined;
  return 1 - ((n - 1) * observed) / expected;
}

function kendallTauB(x: readonly number[], y: readonly number[]): number | undefined {
  let concordant = 0;
  let discordant = 0;
  let tiesX = 0;
  let tiesY = 0;
  for (let i = 0; i < x.length; i += 1) {
    for (let j = i + 1; j < x.length; j += 1) {
      const dx = Math.sign((x[i] ?? 0) - (x[j] ?? 0));
      const dy = Math.sign((y[i] ?? 0) - (y[j] ?? 0));
      if (dx === 0 && dy === 0) continue;
      if (dx === 0) tiesX += 1;
      else if (dy === 0) tiesY += 1;
      else if (dx === dy) concordant += 1;
      else discordant += 1;
    }
  }
  const den = Math.sqrt((concordant + discordant + tiesX) * (concordant + discordant + tiesY));
  return den === 0 ? undefined : (concordant - discordant) / den;
}

interface FitRow {
  readonly caseId: string;
  readonly pass: boolean;
  readonly value: number;
  readonly language: string;
}

function confusion(rows: readonly FitRow[], threshold: number): Confusion {
  let tp = 0;
  let fn = 0;
  let tn = 0;
  let fp = 0;
  for (const row of rows) {
    const predicted = row.value >= threshold - EPS;
    if (row.pass) {
      if (predicted) tp += 1;
      else fn += 1;
    } else if (predicted) fp += 1;
    else tn += 1;
  }
  return { tp, fn, tn, fp };
}

function reliability(
  rows: readonly FitRow[],
  max: number,
): { bins: ReliabilityBin[]; ece?: number } {
  const bins = Array.from({ length: ECE_BINS }, (_, b) => ({ n: 0, sumP: 0, passes: 0, b }));
  for (const row of rows) {
    const p = Math.min(1, Math.max(0, row.value / max));
    const bin = bins[Math.min(ECE_BINS - 1, Math.floor(p * ECE_BINS + EPS))];
    if (!bin) continue;
    bin.n += 1;
    bin.sumP += p;
    if (row.pass) bin.passes += 1;
  }
  let ece = 0;
  const out = bins.map(({ n, sumP, passes, b }): ReliabilityBin => {
    const lo = b / ECE_BINS;
    const hi = (b + 1) / ECE_BINS;
    if (n === 0) return { lo, hi, n };
    const meanP = sumP / n;
    const fracPass = passes / n;
    ece += (n / rows.length) * Math.abs(meanP - fracPass);
    return { lo, hi, n, meanP, fracPass };
  });
  return rows.length === 0 ? { bins: out } : { bins: out, ece };
}

function clusteredRate(
  rows: readonly FitRow[],
  threshold: number,
  keys: ReadonlyMap<string, string>,
): number | undefined {
  if (rows.length === 0) return undefined;
  const values = rows.map((r) => (r.value >= threshold - EPS === r.pass ? 1 : 0));
  const ids = rows.map((r) => keys.get(r.caseId) ?? `case:${r.caseId}`);
  return clusteredSE(values, ids).se ?? undefined;
}

function addReason(reasons: LockReason[], reason: LockReason): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function sliceFor(
  labelCount: number,
  heldOut: readonly FitRow[],
  threshold: number | undefined,
): LanguageSlice {
  const pos = heldOut.filter((r) => r.pass).length;
  const neg = heldOut.length - pos;
  const reasons: LockReason[] = [];
  if (pos < CLASS_FLOOR || neg < CLASS_FLOOR) reasons.push('class_too_small');
  if (threshold === undefined) return { labelCount, status: 'uncalibrated', reasons };
  const c = confusion(heldOut, threshold);
  const tpr = ratio(c.tp, c.tp + c.fn);
  const tnr = ratio(c.tn, c.tn + c.fp);
  const kappa = pos === 0 || neg === 0 ? undefined : cohenKappa(c);
  if (kappa === undefined || kappa < KAPPA_FLOOR) reasons.push('language_limited');
  return {
    labelCount,
    ...(tpr === undefined ? {} : { tpr }),
    ...(tnr === undefined ? {} : { tnr }),
    ...(kappa === undefined ? {} : { kappa }),
    status: reasons.length === 0 ? 'calibrated' : 'uncalibrated',
    reasons,
  };
}

/**
 * Calibrates one criterion against human labels and ≥3 repeated judge responses per case.
 * The threshold is fitted on the train split; every reported metric uses held-out rows only.
 */
export function calibrate(
  criterion: Criterion,
  labels: readonly CalibrationLabel[],
  repeats: ReadonlyMap<string, readonly JudgeResponse[]>,
  cases: readonly Case[],
  options: CalibrateOptions = {},
): CalibrationResult {
  const { seed = 0 } = options;
  const max = scoreMax(criterion);
  const values = repeatValues(criterion, repeats);
  const languageOf = new Map(cases.map((c) => [c.id, c.language ?? 'und']));
  const reasons: LockReason[] = [];

  const known: FitRow[] = [];
  let tooFewRepeats = false;
  for (const { caseId, label } of labels) {
    if (label === 'unknown') continue;
    const vs = values.get(caseId) ?? [];
    if (vs.length < MIN_REPEATS) tooFewRepeats = true;
    if (vs.length === 0) continue;
    known.push({
      caseId,
      pass: label === 'pass',
      value: mean(vs),
      language: languageOf.get(caseId) ?? 'und',
    });
  }

  const split = splitByHash(
    known.map((r) => r.caseId),
    seed,
  );
  const heldOutIds = new Set(split.heldOut);
  const train = known.filter((r) => !heldOutIds.has(r.caseId));
  const heldOut = known.filter((r) => heldOutIds.has(r.caseId));

  if (labels.length < MIN_LABELS) addReason(reasons, 'too_few_labels');
  const knownPos = known.filter((r) => r.pass).length;
  if (knownPos === 0 || knownPos === known.length) addReason(reasons, 'single_class');
  const heldPos = heldOut.filter((r) => r.pass).length;
  const heldNeg = heldOut.length - heldPos;
  if (heldPos === 0 || heldNeg === 0) addReason(reasons, 'single_class_heldout');
  if (heldPos < CLASS_FLOOR || heldNeg < CLASS_FLOOR) addReason(reasons, 'class_too_small');

  const tolerance = repeatTolerance(values);
  if (tooFewRepeats || tolerance === undefined || tolerance >= UNSTABLE_AT) {
    addReason(reasons, 'unstable');
  }

  const threshold = fitThreshold(
    train.map((r) => r.value),
    train.map((r) => r.pass),
    max,
  );
  const c = confusion(heldOut, threshold ?? Number.POSITIVE_INFINITY);
  const tpr = threshold === undefined ? undefined : ratio(c.tp, c.tp + c.fn);
  const tnr = threshold === undefined ? undefined : ratio(c.tn, c.tn + c.fp);
  const agreementDefined = threshold !== undefined && heldPos > 0 && heldNeg > 0;

  let kappa: number | undefined;
  let alpha: number | undefined;
  let kendallTau: number | undefined;
  if (agreementDefined && criterion.type === 'score') {
    alpha = krippendorffAlphaOrdinal(
      heldOut.map((r) => [r.pass ? 1 : 0, r.value >= threshold - EPS ? 1 : 0] as const),
    );
    kendallTau = kendallTauB(
      heldOut.map((r) => r.value),
      heldOut.map((r) => (r.pass ? 1 : 0)),
    );
  } else if (agreementDefined) kappa = cohenKappa(c);

  const keys = clusterKeys(cases);
  const seTpr =
    threshold === undefined
      ? undefined
      : clusteredRate(
          heldOut.filter((r) => r.pass),
          threshold,
          keys,
        );
  const seTnr =
    threshold === undefined
      ? undefined
      : clusteredRate(
          heldOut.filter((r) => !r.pass),
          threshold,
          keys,
        );

  const { bins, ece } = reliability(heldOut, max);

  const labelsByLanguage = new Map<string, number>();
  for (const { caseId } of labels) {
    const lang = languageOf.get(caseId) ?? 'und';
    labelsByLanguage.set(lang, (labelsByLanguage.get(lang) ?? 0) + 1);
  }
  const byLanguage: Record<string, LanguageSlice> = {};
  for (const [lang, count] of labelsByLanguage) {
    byLanguage[lang] = sliceFor(
      count,
      heldOut.filter((r) => r.language === lang),
      threshold,
    );
  }
  const languages = Object.keys(byLanguage)
    .filter((lang) => byLanguage[lang]?.status === 'calibrated')
    .toSorted();
  if (Object.values(byLanguage).some((s) => s.status === 'uncalibrated')) {
    addReason(reasons, 'language_limited');
  }

  const blocking = reasons.filter((r) => r !== 'language_limited');
  const status =
    blocking.length === 0 && languages.length > 0 && threshold !== undefined
      ? 'calibrated'
      : 'uncalibrated';

  return {
    ...(threshold === undefined ? {} : { threshold }),
    ...(tpr === undefined ? {} : { tpr }),
    ...(tnr === undefined ? {} : { tnr }),
    se: {
      ...(seTpr === undefined ? {} : { tpr: seTpr }),
      ...(seTnr === undefined ? {} : { tnr: seTnr }),
    },
    ...(ece === undefined ? {} : { ece }),
    reliability: bins,
    ...(kappa === undefined ? {} : { kappa }),
    ...(alpha === undefined ? {} : { alpha }),
    ...(kendallTau === undefined ? {} : { kendallTau }),
    ...(tolerance === undefined ? {} : { tolerance }),
    heldOut: c,
    split: { train: train.map((r) => r.caseId), heldOut: heldOut.map((r) => r.caseId) },
    byLanguage,
    languages,
    status,
    reasons,
    labelCount: labels.length,
  };
}

export interface CorrectedPassRateInput {
  readonly observedPasses: number;
  readonly observedN: number;
  readonly heldOut: Confusion;
  readonly seed: number;
  readonly resamples?: number;
}

export interface CorrectedPassRateResult {
  readonly theta: number | null;
  readonly ci95: readonly [number, number] | null;
  readonly valid: boolean;
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

function roganGladen(p: number, tpr: number, tnr: number): number | undefined {
  const den = tpr + tnr - 1;
  return den <= 0 ? undefined : clamp01((p + tnr - 1) / den);
}

/** Binomial(n, p) draw: exact Bernoulli sum for small n, normal approximation above. */
function binomial(n: number, p: number, rand: () => number): number {
  if (n <= 500) {
    let k = 0;
    for (let i = 0; i < n; i += 1) if (rand() < p) k += 1;
    return k;
  }
  const u1 = Math.max(rand(), Number.MIN_VALUE);
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * rand());
  return Math.min(n, Math.max(0, Math.round(n * p + z * Math.sqrt(n * p * (1 - p)))));
}

function percentile(sorted: readonly number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] ?? 0;
  const b = sorted[hi] ?? a;
  return a + (b - a) * (pos - lo);
}

/**
 * Rogan-Gladen corrected pass rate θ = (p_obs + TNR − 1)/(TPR + TNR − 1), clamped to [0, 1],
 * with a seeded percentile bootstrap over joint resamples of the observed verdicts and the
 * held-out confusion counts. Invalid (theta null) when TPR + TNR ≤ 1 or a count is empty.
 */
export function correctedPassRate(input: CorrectedPassRateInput): CorrectedPassRateResult {
  const { observedPasses, observedN, heldOut, seed, resamples = 20_000 } = input;
  const nPos = heldOut.tp + heldOut.fn;
  const nNeg = heldOut.tn + heldOut.fp;
  const invalid = { theta: null, ci95: null, valid: false } as const;
  if (observedN <= 0 || nPos === 0 || nNeg === 0) return invalid;
  const p = observedPasses / observedN;
  const tpr = heldOut.tp / nPos;
  const tnr = heldOut.tn / nNeg;
  const theta = roganGladen(p, tpr, tnr);
  if (theta === undefined) return invalid;

  const rand = mulberry32(seed);
  const draws: number[] = [];
  for (let i = 0; i < resamples; i += 1) {
    const pStar = binomial(observedN, p, rand) / observedN;
    const tprStar = binomial(nPos, tpr, rand) / nPos;
    const tnrStar = binomial(nNeg, tnr, rand) / nNeg;
    const t = roganGladen(pStar, tprStar, tnrStar);
    if (t !== undefined) draws.push(t);
  }
  if (draws.length === 0) return { theta, ci95: null, valid: true };
  draws.sort((a, b) => a - b);
  return { theta, ci95: [percentile(draws, 0.025), percentile(draws, 0.975)], valid: true };
}
