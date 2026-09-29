import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Trace } from './corpus.ts';
import { buildQuestions, buildState, cacheKey, MODEL } from './judge.ts';
import { loadExistingRows, type LabelRow } from './label.ts';
import { readJsonl } from './lib/index.ts';
import type { Criterion } from './propose.ts';

const DATA_DIR = fileURLToPath(new URL('./data/', import.meta.url));
const TRACES_PATH = join(DATA_DIR, 'traces.jsonl');
const CRITERIA_PATH = join(DATA_DIR, 'criteria.json');
const LABELS_PATH = join(DATA_DIR, 'labels.csv');
const CACHE_DIR = join(DATA_DIR, 'cache');
const REPORT_PATH = fileURLToPath(new URL('./REPORT.md', import.meta.url));
const VARIANTS = ['bm25', 'embedding', 'hybrid', 'hybrid-norerank'];
const LANGS = ['en', 'ru', 'kk'];

const REPEATS = 3;
const JEV_INPUT_COST_PER_MILLION = 0.042;
const MIN_HUMAN_TRACES = 30;
const MIN_TOTAL_LABEL_ROWS = 300;
const KAPPA_PASS_BAR = 0.6;
const TPR_PASS_BAR = 0.8;
const TNR_PASS_BAR = 0.8;
const FLIP_PASS_BAR = 0.05;
const MEDIAN_KAPPA_NO_GO_BAR = 0.4;
const ESCAPE_UNANSWERABLE_BAR = 0.3;
/** The spike's go/no-go rule, quoted verbatim in the report. */
export const CONTRACT_RULE_TEXT =
  'GO if ≥7 of 10 criteria reach κ ≥ 0.6 with TPR ≥ 0.8 and TNR ≥ 0.8 on ' +
  'the labelled set and the boolean flip rate at threshold is ≤ 5%; AMEND (criteria need ' +
  'wording rules) if 4–6 criteria pass; NO-GO if median κ < 0.4';
const JEV_RELEASE_DATE = '2026-09-15';
const JEV_RELEASE_DATE_SOURCE = 'docs/research/fixtures/2026-09-25-gateway-models.json';

/** Cohen's kappa for two same-length boolean raters. Null when chance agreement is 1 (undefined). */
export function cohenKappa(a: boolean[], b: boolean[]): number | null {
  if (a.length !== b.length) throw new Error('cohenKappa: arrays must be the same length');
  const n = a.length;
  if (n === 0) return null;
  let agree = 0;
  let aYes = 0;
  let bYes = 0;
  for (let i = 0; i < n; i++) {
    if (a[i] === b[i]) agree++;
    if (a[i]) aYes++;
    if (b[i]) bYes++;
  }
  const pA = aYes / n;
  const pB = bYes / n;
  const po = agree / n;
  const pe = pA * pB + (1 - pA) * (1 - pB);
  if (pe === 1) return null;
  return (po - pe) / (1 - pe);
}

/**
 * Krippendorff's alpha (nominal metric), 2+ raters per unit, `null` for missing values.
 * Units with fewer than 2 non-null values are unpairable and excluded.
 */
export function krippendorffAlphaNominal(rows: (boolean | null)[][]): number | null {
  const categories = new Set<string>();
  const coincidence = new Map<string, number>();
  const marginal = new Map<string, number>();
  let n = 0;

  for (const row of rows) {
    const values = row.filter((v): v is boolean => v !== null).map(String);
    const m = values.length;
    if (m < 2) continue;
    const weight = 1 / (m - 1);
    for (let i = 0; i < m; i++) {
      for (let j = i + 1; j < m; j++) {
        const c = values[i];
        const k = values[j];
        if (c === undefined || k === undefined) continue;
        categories.add(c);
        categories.add(k);
        coincidence.set(`${c}|${k}`, (coincidence.get(`${c}|${k}`) ?? 0) + weight);
        coincidence.set(`${k}|${c}`, (coincidence.get(`${k}|${c}`) ?? 0) + weight);
        marginal.set(c, (marginal.get(c) ?? 0) + weight);
        marginal.set(k, (marginal.get(k) ?? 0) + weight);
        n += 2 * weight;
      }
    }
  }

  if (n === 0) return null;

  let observedDisagree = 0;
  let expectedDisagree = 0;
  for (const c of categories) {
    for (const k of categories) {
      if (c === k) continue;
      observedDisagree += coincidence.get(`${c}|${k}`) ?? 0;
      expectedDisagree += (marginal.get(c) ?? 0) * (marginal.get(k) ?? 0);
    }
  }
  const de = expectedDisagree / (n * (n - 1));
  if (de === 0) return null;
  return 1 - observedDisagree / n / de;
}

export type Rates = { accuracy: number; tpr: number | null; tnr: number | null };

/** TPR/TNR/accuracy of thresholding `scores >= t` against boolean `labels`. */
export function rates(scores: number[], labels: boolean[], t: number): Rates {
  if (scores.length !== labels.length) throw new Error('rates: arrays must be the same length');
  let tp = 0;
  let fn = 0;
  let tn = 0;
  let fp = 0;
  for (const [i, score] of scores.entries()) {
    const predicted = score >= t;
    const actual = labels[i];
    if (actual && predicted) tp++;
    else if (actual && !predicted) fn++;
    else if (!actual && predicted) fp++;
    else tn++;
  }
  const positives = tp + fn;
  const negatives = tn + fp;
  return {
    accuracy: (tp + tn) / scores.length,
    tpr: positives > 0 ? tp / positives : null,
    tnr: negatives > 0 ? tn / negatives : null,
  };
}

/** Fits the threshold on `scores >= t` maximising Youden's J (TPR + TNR - 1) over observed scores. */
export function fitThreshold(scores: number[], labels: boolean[]): number {
  if (scores.length !== labels.length || scores.length === 0) {
    throw new Error('fitThreshold: need at least one score/label pair');
  }
  const candidates = Array.from(new Set(scores)).toSorted((a, b) => a - b);
  let best = candidates[0];
  if (best === undefined) throw new Error('fitThreshold: need at least one score/label pair');
  let bestJ = -Infinity;
  for (const t of candidates) {
    const { tpr, tnr } = rates(scores, labels, t);
    const j = (tpr ?? 0) + (tnr ?? 0) - 1;
    if (j > bestJ) {
      bestJ = j;
      best = t;
    }
  }
  return best;
}

/** Share of (trace, criterion) rows whose repeats have at least one score on each side of `t`. */
export function flipRate(repeatsPerTrace: number[][], t: number): number {
  if (repeatsPerTrace.length === 0) return 0;
  const flips = repeatsPerTrace.filter(
    (repeats) => repeats.some((v) => v >= t) && repeats.some((v) => v < t),
  ).length;
  return flips / repeatsPerTrace.length;
}

/** A criterion passes iff kappa, TPR and TNR clear their bars and the flip rate does not. */
export function criterionPasses(row: {
  kappa: number | null;
  tpr: number | null;
  tnr: number | null;
  flipPct: number;
}): boolean {
  return (
    row.kappa !== null &&
    row.kappa >= KAPPA_PASS_BAR &&
    row.tpr !== null &&
    row.tpr >= TPR_PASS_BAR &&
    row.tnr !== null &&
    row.tnr >= TNR_PASS_BAR &&
    row.flipPct <= FLIP_PASS_BAR
  );
}

/** Median over the non-null values; null (undefined/n-a values are excluded, not treated as 0). */
export function medianOfDefined(values: (number | null)[]): number | null {
  const defined = values.filter((v): v is number => v !== null).toSorted((a, b) => a - b);
  const n = defined.length;
  if (n === 0) return null;
  const mid = Math.floor(n / 2);
  const upper = defined[mid];
  if (upper === undefined) return null;
  if (n % 2 !== 0) return upper;
  const lower = defined[mid - 1];
  return lower === undefined ? null : (lower + upper) / 2;
}

export type Outcome = 'GO' | 'AMEND' | 'NO-GO' | 'INCONCLUSIVE';

/**
 * GO/AMEND/NO-GO rule (>=7 of 10 criteria passing -> GO,
 * else AMEND), extended with a NO-GO override when c1
 * accuracy < 0.9 or the median kappa across criteria (undefined kappas excluded) is < 0.4, and
 * INCONCLUSIVE when there are not yet enough human labels to trust the pass count (fewer than 30
 * human-labelled traces or fewer than 300 total label rows). Precedence: INCONCLUSIVE, then the
 * c1-accuracy override, then the median-kappa override, then the pass count.
 */
export function decideOutcome(input: {
  humanTraces: number;
  totalLabelRows: number;
  c1Accuracy: number | null;
  passCount: number;
  medianKappa: number | null;
}): Outcome {
  if (input.humanTraces < MIN_HUMAN_TRACES || input.totalLabelRows < MIN_TOTAL_LABEL_ROWS) {
    return 'INCONCLUSIVE';
  }
  if (input.c1Accuracy !== null && input.c1Accuracy < 0.9) return 'NO-GO';
  if (input.medianKappa !== null && input.medianKappa < MEDIAN_KAPPA_NO_GO_BAR) return 'NO-GO';
  if (input.passCount >= 7) return 'GO';
  return 'AMEND';
}

export type LabelCheck = {
  humanTraces: number;
  modelTraces: number;
  /** Distinct traces with a human or model label; this is what the INCONCLUSIVE bar counts. */
  labelledTraces: number;
  humanRows: number;
  modelRows: number;
  totalRows: number;
  ok: boolean;
};

/** `--check-labels`: distinct human+model-labelled traces vs total label rows, against the same bars as decideOutcome. */
export function checkLabels(rows: LabelRow[]): LabelCheck {
  const tracesOf = (source: LabelRow['source']): Set<string> =>
    new Set(rows.filter((r) => r.source === source).map((r) => r.traceId));
  const human = tracesOf('human');
  const model = tracesOf('model');
  const labelled = new Set([...human, ...model]);
  return {
    humanTraces: human.size,
    modelTraces: model.size,
    labelledTraces: labelled.size,
    humanRows: rows.filter((r) => r.source === 'human').length,
    modelRows: rows.filter((r) => r.source === 'model').length,
    totalRows: rows.length,
    ok: labelled.size >= MIN_HUMAN_TRACES && rows.length >= MIN_TOTAL_LABEL_ROWS,
  };
}

const TRUTH_RANK: Partial<Record<LabelRow['source'], number>> = { auto: 1, model: 2, human: 3 };

/** Truth per `traceId|criterionId`: human beats model beats auto; baseline rows are not truth. */
export function resolveTruth(rows: LabelRow[]): Map<string, LabelRow> {
  const truth = new Map<string, LabelRow>();
  for (const row of rows) {
    const rank = TRUTH_RANK[row.source];
    if (rank === undefined) continue;
    const key = `${row.traceId}|${row.criterionId}`;
    const current = truth.get(key);
    if (!current || rank >= (TRUTH_RANK[current.source] ?? 0)) truth.set(key, row);
  }
  return truth;
}

export const PROVISIONAL_NOTE = 'PROVISIONAL (model-labelled)';

/** True when any resolved truth row is model-labelled, so the report is provisional. */
export function usesModelLabels(truth: Map<string, LabelRow>): boolean {
  return [...truth.values()].some((r) => r.source === 'model');
}

// ---------------------------------------------------------------------------
// Cache-backed P(yes) derivation: no network calls, reuses judge.ts's builders and
// cacheKey to find the already-fetched response on disk.
// ---------------------------------------------------------------------------

type CachedCall = {
  key: string;
  inputTokens: number;
  /** Per criterion: P(yes) and whether the top choice was the criterion's escape option. */
  byCriterion: Map<string, { pYes: number; escaped: boolean }>;
};

async function loadCachedCall(
  trace: Trace,
  repeat: number,
  criteria: Criterion[],
): Promise<CachedCall | null> {
  const state = buildState(trace);
  const questions = buildQuestions(criteria, trace);
  const key = cacheKey(state, questions, repeat, MODEL);
  const path = join(CACHE_DIR, `${key}.json`);
  if (!existsSync(path)) return null;

  const raw: {
    answers?: Record<string, { choice?: string; probabilities?: { yes?: number } }>;
    usage?: { input_tokens?: number };
  } = JSON.parse(await readFile(path, 'utf8'));

  const byCriterion = new Map<string, { pYes: number; escaped: boolean }>();
  for (const c of criteria) {
    const answer = raw.answers?.[c.id];
    const pYes = answer?.probabilities?.yes;
    if (typeof pYes === 'number') {
      byCriterion.set(c.id, { pYes, escaped: answer?.choice !== 'yes' && answer?.choice !== 'no' });
    }
  }
  return { key, inputTokens: raw.usage?.input_tokens ?? 0, byCriterion };
}

type TraceCriterionRepeats = { pYes: number; escaped: boolean }[];

export type Corpus = {
  /** `${traceId}|${criterionId}` -> that trace's repeats' P(yes)/escaped, in repeat order. */
  byTraceCriterion: Map<string, TraceCriterionRepeats>;
  logicalCalls: number;
  uniqueCalls: number;
  uniqueCallInputTokens: number;
  logicalCallInputTokens: number;
};

/** Walks every (trace, repeat), reading each cached response once, tallying cost both ways. */
async function loadCorpus(traces: Trace[], criteria: Criterion[]): Promise<Corpus> {
  const byTraceCriterion = new Map<string, TraceCriterionRepeats>();
  const seenKeys = new Set<string>();
  let logicalCalls = 0;
  let uniqueCallInputTokens = 0;
  let logicalCallInputTokens = 0;

  for (const trace of traces) {
    for (let repeat = 0; repeat < REPEATS; repeat++) {
      logicalCalls++;
      const call = await loadCachedCall(trace, repeat, criteria);
      if (!call) continue;
      logicalCallInputTokens += call.inputTokens;
      if (!seenKeys.has(call.key)) {
        seenKeys.add(call.key);
        uniqueCallInputTokens += call.inputTokens;
      }
      for (const c of criteria) {
        const value = call.byCriterion.get(c.id);
        if (!value) continue;
        const mapKey = `${trace.traceId}|${c.id}`;
        const list = byTraceCriterion.get(mapKey) ?? [];
        list.push(value);
        byTraceCriterion.set(mapKey, list);
      }
    }
  }

  return {
    byTraceCriterion,
    logicalCalls,
    uniqueCalls: seenKeys.size,
    uniqueCallInputTokens,
    logicalCallInputTokens,
  };
}

// ---------------------------------------------------------------------------
// Per-criterion table: truth = human > model > auto labels (Gemini baseline rows are never truth;
// they are reported separately in the baseline block).
// ---------------------------------------------------------------------------

export const NOT_EVALUABLE = 'not evaluable (single-class truth)';

export type CriterionRow = {
  id: string;
  n: number;
  kappa: number | null;
  alpha: number | null;
  threshold: number | null;
  tpr: number | null;
  tnr: number | null;
  flipPct: number;
  escapePct: number;
  verdict: 'pass' | 'fail' | 'unanswerable' | 'pending' | 'n/a' | typeof NOT_EVALUABLE;
};

export function computeCriterionRow(
  criterionId: string,
  traces: Trace[],
  truthByKey: Map<string, LabelRow>,
  corpus: Corpus,
): CriterionRow {
  // n counts traces that have a truth label for this criterion (human > model > auto); unlabelled
  // traces are excluded from every statistic and from n.
  let n = 0;
  // Two different reasons a trace contributes nothing to the fit, tracked separately: no truth
  // label exists at all for this criterion (c3's baseline-sourced truth and c4-c10's not-yet-
  // human-labelled truth both land here, reported as 'pending', not as an escape), vs a truth
  // label of 'review' or a fully-escaped judge answer (the "unknown/review rows excluded from
  // kappa but counted in escape%" edge case) - only the latter counts toward escape%.
  let reviewOrEscaped = 0;
  const scoresForFit: number[] = [];
  const labelsForFit: boolean[] = [];
  const repeatsForFlip: number[][] = [];

  for (const trace of traces) {
    const labelRow = truthByKey.get(`${trace.traceId}|${criterionId}`);
    const repeats = corpus.byTraceCriterion.get(`${trace.traceId}|${criterionId}`) ?? [];
    const nonEscaped = repeats.filter((r) => !r.escaped);
    const meanPYes =
      nonEscaped.length > 0 ? nonEscaped.reduce((s, r) => s + r.pYes, 0) / nonEscaped.length : null;
    const allEscaped = repeats.length > 0 && nonEscaped.length === 0;

    if (!labelRow) continue; // no truth for this trace at all (reported as 'pending', not an escape)
    n++;
    if (labelRow.label === 'review' || allEscaped || meanPYes === null) {
      reviewOrEscaped++;
      continue;
    }

    scoresForFit.push(meanPYes);
    labelsForFit.push(labelRow.label === 'yes');
    if (repeats.length > 0) repeatsForFlip.push(repeats.map((r) => r.pYes));
  }

  const escapePct = n > 0 ? reviewOrEscaped / n : 0;

  if (scoresForFit.length === 0) {
    return {
      id: criterionId,
      n,
      kappa: null,
      alpha: null,
      threshold: null,
      tpr: null,
      tnr: null,
      flipPct: 0,
      escapePct,
      verdict: 'pending',
    };
  }

  const threshold = fitThreshold(scoresForFit, labelsForFit);
  // Single-class truth (all yes or all no, review excluded): kappa/alpha are undefined, not 0.
  const singleClass = new Set(labelsForFit).size < 2;
  const { tpr, tnr } = rates(scoresForFit, labelsForFit, threshold);
  const predictions = scoresForFit.map((s) => s >= threshold);
  const kappa = singleClass ? null : cohenKappa(predictions, labelsForFit);
  const alpha = singleClass
    ? null
    : krippendorffAlphaNominal(predictions.map((p, i) => [p, labelsForFit[i] ?? null]));
  const flipPct = flipRate(repeatsForFlip, threshold);

  const verdict: CriterionRow['verdict'] = singleClass
    ? NOT_EVALUABLE
    : escapePct > ESCAPE_UNANSWERABLE_BAR
      ? 'unanswerable'
      : kappa === null
        ? 'n/a'
        : criterionPasses({ kappa, tpr, tnr, flipPct })
          ? 'pass'
          : 'fail';

  return { id: criterionId, n, kappa, alpha, threshold, tpr, tnr, flipPct, escapePct, verdict };
}

function fmt(value: number | null, digits = 3): string {
  return value === null ? 'n/a' : value.toFixed(digits);
}

function fmtPct(value: number | null, digits = 1): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(digits)}%`;
}

function criterionTableMarkdown(rows: CriterionRow[]): string {
  const header = '| c | n | κ | α | threshold | TPR | TNR | flip% | escape% | verdict |';
  const divider = '|---|---|---|---|---|---|---|---|---|---|';
  const body = rows.map(
    (r) =>
      `| ${r.id} | ${r.n} | ${fmt(r.kappa)} | ${fmt(r.alpha)} | ${fmt(r.threshold)} | ${fmt(r.tpr)} | ${fmt(r.tnr)} | ${fmtPct(r.flipPct)} | ${fmtPct(r.escapePct)} | ${r.verdict} |`,
  );
  return [header, divider, ...body].join('\n');
}

// ---------------------------------------------------------------------------
// Ground-truth block: c1 vs the reference-derived auto labels, c2 on the
// 24 unanswerable rows.
// ---------------------------------------------------------------------------

function groundTruthRateRow(
  label: string,
  traces: Trace[],
  criterionId: string,
  truthByKey: Map<string, LabelRow>,
  corpus: Corpus,
  threshold: number,
): string {
  const scores: number[] = [];
  const labels: boolean[] = [];
  for (const trace of traces) {
    const labelRow = truthByKey.get(`${trace.traceId}|${criterionId}`);
    if (!labelRow || labelRow.label === 'review') continue;
    const repeats = (corpus.byTraceCriterion.get(`${trace.traceId}|${criterionId}`) ?? []).filter(
      (r) => !r.escaped,
    );
    if (repeats.length === 0) continue;
    scores.push(repeats.reduce((s, r) => s + r.pYes, 0) / repeats.length);
    labels.push(labelRow.label === 'yes');
  }
  if (scores.length === 0) return `| ${label} | 0 | n/a | n/a | n/a |`;
  const { accuracy, tpr, tnr } = rates(scores, labels, threshold);
  return `| ${label} | ${scores.length} | ${fmt(accuracy)} | ${fmt(tpr)} | ${fmt(tnr)} |`;
}

function groundTruthBlock(
  traces: Trace[],
  truthByKey: Map<string, LabelRow>,
  corpus: Corpus,
  c1Row: CriterionRow,
  c2Row: CriterionRow,
): { markdown: string; c1Accuracy: number | null } {
  const lines: string[] = [];
  lines.push('### c1 answer_correct vs the reference-derived labels');
  lines.push('');
  lines.push('| slice | n | accuracy | TPR | TNR |');
  lines.push('|---|---|---|---|---|');
  let c1Accuracy: number | null = null;
  if (c1Row.threshold !== null) {
    const allRow = groundTruthRateRow('all', traces, 'c1', truthByKey, corpus, c1Row.threshold);
    lines.push(allRow);
    const match = /\| all \| \d+ \| ([\d.]+|n\/a) \|/.exec(allRow);
    c1Accuracy = match && match[1] !== 'n/a' ? Number(match[1]) : null;
    for (const variant of VARIANTS) {
      lines.push(
        groundTruthRateRow(
          `variant:${variant}`,
          traces.filter((t) => t.variant === variant),
          'c1',
          truthByKey,
          corpus,
          c1Row.threshold,
        ),
      );
    }
  } else {
    lines.push('| all | 0 | n/a | n/a | n/a |');
  }

  lines.push('');
  lines.push('### c2 abstains_when_unanswerable on the golden-unanswerable rows');
  lines.push('');
  lines.push('| slice | n | accuracy | TPR | TNR |');
  lines.push('|---|---|---|---|---|');
  if (c2Row.threshold !== null) {
    lines.push(
      groundTruthRateRow(
        'unanswerable',
        traces.filter((t) => t.unanswerable),
        'c2',
        truthByKey,
        corpus,
        c2Row.threshold,
      ),
    );
  } else {
    lines.push('| unanswerable | 0 | n/a | n/a | n/a |');
  }

  return { markdown: lines.join('\n'), c1Accuracy };
}

// ---------------------------------------------------------------------------
// Baseline block: Cohen kappa between thresholded Jev c3 and the Gemini
// faithfulness score, binarised at 0.5 (already the labels.csv `baseline` rows).
// ---------------------------------------------------------------------------

function baselineKappaRow(
  label: string,
  traces: Trace[],
  baselineByKey: Map<string, LabelRow>,
  corpus: Corpus,
  threshold: number,
): string {
  const predicted: boolean[] = [];
  const baseline: boolean[] = [];
  for (const trace of traces) {
    const labelRow = baselineByKey.get(`${trace.traceId}|c3`);
    if (!labelRow) continue;
    const repeats = (corpus.byTraceCriterion.get(`${trace.traceId}|c3`) ?? []).filter(
      (r) => !r.escaped,
    );
    if (repeats.length === 0) continue;
    const meanPYes = repeats.reduce((s, r) => s + r.pYes, 0) / repeats.length;
    predicted.push(meanPYes >= threshold);
    baseline.push(labelRow.label === 'yes');
  }
  if (predicted.length === 0) return `| ${label} | 0 | n/a |`;
  const kappa = cohenKappa(predicted, baseline);
  return `| ${label} | ${predicted.length} | ${fmt(kappa)} |`;
}

/** Jev c3 (thresholded at `threshold`) vs the model-labelled c3 truth, as a `| slice | n | κ |` row. */
export function modelLabelKappaRow(
  traces: Trace[],
  truthByKey: Map<string, LabelRow>,
  corpus: Corpus,
  threshold: number,
): string {
  const predicted: boolean[] = [];
  const truth: boolean[] = [];
  for (const trace of traces) {
    const labelRow = truthByKey.get(`${trace.traceId}|c3`);
    if (labelRow?.source !== 'model' || labelRow.label === 'review') continue;
    const repeats = (corpus.byTraceCriterion.get(`${trace.traceId}|c3`) ?? []).filter(
      (r) => !r.escaped,
    );
    if (repeats.length === 0) continue;
    predicted.push(repeats.reduce((s, r) => s + r.pYes, 0) / repeats.length >= threshold);
    truth.push(labelRow.label === 'yes');
  }
  if (predicted.length === 0) return '| model labels | 0 | n/a |';
  return `| model labels | ${predicted.length} | ${fmt(cohenKappa(predicted, truth))} |`;
}

function baselineBlock(
  traces: Trace[],
  baselineByKey: Map<string, LabelRow>,
  corpus: Corpus,
  c3Threshold: number | null,
): string {
  const lines = ['| slice | n | κ |', '|---|---|---|'];
  if (c3Threshold === null) {
    lines.push('| all | 0 | n/a |');
    return lines.join('\n');
  }
  lines.push(baselineKappaRow('all', traces, baselineByKey, corpus, c3Threshold));
  for (const lang of LANGS) {
    lines.push(
      baselineKappaRow(
        `lang:${lang}`,
        traces.filter((t) => t.lang === lang),
        baselineByKey,
        corpus,
        c3Threshold,
      ),
    );
  }
  return lines.join('\n');
}

/** c3 threshold fitted against the baseline (Gemini @ 0.5) labels, for the baseline block. */
function fitC3ThresholdAgainstBaseline(
  traces: Trace[],
  baselineByKey: Map<string, LabelRow>,
  corpus: Corpus,
): number | null {
  const scores: number[] = [];
  const labels: boolean[] = [];
  for (const trace of traces) {
    const labelRow = baselineByKey.get(`${trace.traceId}|c3`);
    if (!labelRow) continue;
    const repeats = (corpus.byTraceCriterion.get(`${trace.traceId}|c3`) ?? []).filter(
      (r) => !r.escaped,
    );
    if (repeats.length === 0) continue;
    scores.push(repeats.reduce((s, r) => s + r.pYes, 0) / repeats.length);
    labels.push(labelRow.label === 'yes');
  }
  return scores.length > 0 ? fitThreshold(scores, labels) : null;
}

type HaystackCost = { judgePromptTokens: number; judgeCompletionTokens: number };

async function readHaystackCost(haystackDir: string): Promise<HaystackCost> {
  let judgePromptTokens = 0;
  let judgeCompletionTokens = 0;
  for (const variant of VARIANTS) {
    const path = join(haystackDir, 'report', `eval-${variant}.json`);
    const raw: { cost?: { judge_prompt_tokens?: number; judge_completion_tokens?: number } } =
      JSON.parse(await readFile(path, 'utf8'));
    judgePromptTokens += raw.cost?.judge_prompt_tokens ?? 0;
    judgeCompletionTokens += raw.cost?.judge_completion_tokens ?? 0;
  }
  return { judgePromptTokens, judgeCompletionTokens };
}

function costBlock(corpus: Corpus, haystack: HaystackCost): string {
  const jevCost = (corpus.uniqueCallInputTokens / 1_000_000) * JEV_INPUT_COST_PER_MILLION;
  const geminiTokens = haystack.judgePromptTokens + haystack.judgeCompletionTokens;
  return [
    `Jev: ${corpus.uniqueCallInputTokens} input tokens over ${corpus.uniqueCalls} unique cached calls ` +
      `(${corpus.logicalCalls} logical calls: 456 traces x 3 repeats; ${corpus.logicalCallInputTokens} ` +
      'input tokens if every logical call were billed separately, but only the unique calls were actually ' +
      `sent to the gateway) ~= $${jevCost.toFixed(4)} at $${JEV_INPUT_COST_PER_MILLION}/M input.`,
    `Gemini plain-mode judge (from the four ~/Projects/haystack-hypothesis/report/eval-*.json cost blocks): ` +
      `${haystack.judgePromptTokens} judge_prompt_tokens + ${haystack.judgeCompletionTokens} ` +
      `judge_completion_tokens = ${geminiTokens} tokens.`,
    'The c4-c10 generator was openai/gpt-5-mini (free-tier gateway, 4 calls); its usage was not recorded ' +
      'by spike/lib, so generator cost is not available.',
  ].join('\n\n');
}

/** Note under table (a): what truth each criterion uses and how much of it is model-labelled. */
export function criterionTableNote(check: LabelCheck): string {
  return (
    'Truth is human > model > auto; n is the number of labelled traces per criterion. This run has ' +
    `${check.modelRows} model-labelled rows over ${check.modelTraces} traces and ${check.humanRows} human-labelled rows, ` +
    'so c3-c10 rows rest on model labels. For c4-c10 a yes label means the problem is present. Gemini ' +
    'baseline scores are not truth and are reported in block (c). ' +
    "c2's auto label is a *correctness* judgment (abstained-when-it-should, or didn't-" +
    "when-it-shouldn't), which flips sign between answerable and unanswerable rows, so its raw " +
    "P(yes)-vs-label kappa above is not directly comparable to c1's; see block (b) for the c2 " +
    'accuracy computed only on the unambiguous (golden-unanswerable) subset.'
  );
}

export function limitationsParagraph(
  haystackAggregateFaithfulness: number[],
  check: LabelCheck,
  notEvaluable: string[],
): string {
  const nearCeiling = haystackAggregateFaithfulness.map((f) => f.toFixed(3)).join(', ');
  return [
    'Contexts are whole source documents (55-344 words) rebuilt offline from corpus/*.pdf|docx, not the ' +
      '120-word chunks the pipeline actually retrieved by; the local Langfuse instance runs in v4 events-only ' +
      'mode and /api/public/traces returned 404 (probed 2026-09-25), so the judged unit is whole-document ' +
      'context, not the retrieved chunk.',
    `Labels: this run has ${check.humanTraces} human-labelled traces (${check.humanRows} rows) and ` +
      `${check.modelTraces} model-labelled traces (${check.modelRows} rows); truth precedence is human, ` +
      'then model, then auto. Model labels stand in for a human labeller, so any decision drawn from ' +
      'them is provisional. With a single labeller, Krippendorff alpha reduces to plain agreement ' +
      'between the labeller and the judge; a second labeller is out of scope of this spike.',
    notEvaluable.length > 0
      ? `Not evaluable: ${notEvaluable.join(', ')} - the labelled sample has no positive cases (or no negative cases) ` +
        'for them, so truth is single-class and kappa is undefined; they are excluded from the median-kappa rule ' +
        'and cannot count toward the pass count.'
      : 'Not evaluable: none (every criterion has two-class truth).',
    `Jev is reached only through the gateway alias ${MODEL} (TypeSafe registration is closed); the served ` +
      `model id recorded on every verdict is that alias, release_date ${JEV_RELEASE_DATE} per ` +
      `${JEV_RELEASE_DATE_SOURCE}; \`pinned: false\`.`,
    `The Gemini baseline is near ceiling: per-variant aggregate faithfulness across the four haystack-hypothesis ` +
      `runs is ${nearCeiling} (bm25/embedding/hybrid/hybrid-norerank) - the baseline comparison (block c) shows ` +
      'Jev reads references and abstentions reliably where the baseline rarely scores unfaithful, not that it ' +
      'catches subtle hallucinations.',
  ].join('\n\n');
}

async function main(): Promise<void> {
  const labelRows = loadExistingRows(LABELS_PATH);

  if (process.argv.includes('--check-labels')) {
    const check = checkLabels(labelRows);
    console.log(
      `labels: ${check.labelledTraces} traces (human+model), ${check.totalRows} rows; ` +
        `human ${check.humanTraces} traces / ${check.humanRows} rows, ` +
        `model ${check.modelTraces} traces / ${check.modelRows} rows`,
    );
    if (check.modelRows > 0) console.log(PROVISIONAL_NOTE);
    if (!check.ok) process.exitCode = 1;
    return;
  }

  const haystackDir =
    process.env.HAYSTACK_HYPOTHESIS_DIR ?? join(homedir(), 'Projects', 'haystack-hypothesis');
  const traces = await readJsonl<Trace>(TRACES_PATH);
  const criteria: Criterion[] = JSON.parse(await readFile(CRITERIA_PATH, 'utf8'));
  const corpus = await loadCorpus(traces, criteria);

  const check = checkLabels(labelRows);
  const truthByKey = resolveTruth(labelRows);
  const provisional = usesModelLabels(truthByKey);
  const baselineByKey = new Map<string, LabelRow>();
  for (const row of labelRows) {
    if (row.source === 'baseline') baselineByKey.set(`${row.traceId}|${row.criterionId}`, row);
  }

  const criterionRows = criteria.map((c) => computeCriterionRow(c.id, traces, truthByKey, corpus));
  const requireRow = (id: string): CriterionRow => {
    const found = criterionRows.find((r) => r.id === id);
    if (!found) throw new Error(`report.ts: criteria.json has no criterion ${id}`);
    return found;
  };
  const c1Row = requireRow('c1');
  const c2Row = requireRow('c2');

  const { markdown: groundTruthMarkdown, c1Accuracy } = groundTruthBlock(
    traces,
    truthByKey,
    corpus,
    c1Row,
    c2Row,
  );

  const c3Threshold = fitC3ThresholdAgainstBaseline(traces, baselineByKey, corpus);
  const c3ModelThreshold = requireRow('c3').threshold;
  const baselineMarkdown = [
    baselineBlock(traces, baselineByKey, corpus, c3Threshold),
    '',
    'Jev c3 vs the model-labelled c3 truth (thresholded at the c3 threshold fitted in table (a)):',
    '',
    '| slice | n | κ |',
    '|---|---|---|',
    c3ModelThreshold === null
      ? '| model labels | 0 | n/a |'
      : modelLabelKappaRow(traces, truthByKey, corpus, c3ModelThreshold),
  ].join('\n');

  const haystackCost = await readHaystackCost(haystackDir);
  const costMarkdown = costBlock(corpus, haystackCost);

  const haystackAggregates: number[] = [];
  for (const variant of VARIANTS) {
    const summary: { aggregate?: { scores?: { faithfulness?: number } } } = JSON.parse(
      await readFile(join(haystackDir, 'report', `eval-${variant}.json`), 'utf8'),
    );
    if (typeof summary.aggregate?.scores?.faithfulness === 'number') {
      haystackAggregates.push(summary.aggregate.scores.faithfulness);
    }
  }
  const limitationsMarkdown = limitationsParagraph(
    haystackAggregates,
    check,
    criterionRows.filter((r) => r.verdict === NOT_EVALUABLE).map((r) => r.id),
  );

  const passCount = criterionRows.filter((r) => r.verdict === 'pass').length;
  const medianKappa = medianOfDefined(criterionRows.map((r) => r.kappa));
  const decision = decideOutcome({
    humanTraces: check.labelledTraces,
    totalLabelRows: check.totalRows,
    c1Accuracy,
    passCount,
    medianKappa,
  });

  const markdown = [
    '# Spike report: Jev vs ground truth, Jev vs the Gemini judge',
    '',
    ...(provisional ? [PROVISIONAL_NOTE, ''] : []),
    '## (a) Per-criterion table (human > model > auto labels as truth)',
    '',
    criterionTableMarkdown(criterionRows),
    '',
    criterionTableNote(check),
    '',
    '## (b) Ground-truth block',
    '',
    groundTruthMarkdown,
    '',
    '## (c) Baseline block (Jev c3 vs the Gemini judge, binarised at 0.5; plus vs model labels)',
    '',
    baselineMarkdown,
    '',
    '## (d) Cost',
    '',
    costMarkdown,
    '',
    '## (e) Limitations',
    '',
    limitationsMarkdown,
    '',
    '## Decision rule',
    '',
    CONTRACT_RULE_TEXT,
    '',
    "Extended per this bead's acceptance criteria with a NO-GO override when c1 accuracy < 0.9.",
    '',
    'Precedence: INCONCLUSIVE (fewer than 30 human-labelled traces or 300 total label rows) first; ' +
      'then c1 accuracy < 0.9 -> NO-GO; then median kappa < 0.4 -> NO-GO; then >=7 criteria passing ' +
      '-> GO; otherwise AMEND.',
    '',
    `Decision: ${decision}${provisional ? ` ${PROVISIONAL_NOTE}` : ''}`,
    '',
  ].join('\n');

  await writeFile(REPORT_PATH, markdown, 'utf8');
  console.log(`report.ts: wrote ${REPORT_PATH}`);
}

if (import.meta.main) {
  await main();
}
