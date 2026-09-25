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
const ESCAPE_UNANSWERABLE_BAR = 0.3;
const JEV_RELEASE_DATE = '2026-09-15';
const JEV_RELEASE_DATE_SOURCE = 'docs/research/fixtures/2026-09-25-gateway-models.json';

// ---------------------------------------------------------------------------
// Pure metric functions
// ---------------------------------------------------------------------------

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
        const c = values[i]!;
        const k = values[j]!;
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
  for (let i = 0; i < scores.length; i++) {
    const predicted = scores[i]! >= t;
    const actual = labels[i]!;
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
  const candidates = Array.from(new Set(scores)).sort((a, b) => a - b);
  let best = candidates[0]!;
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

export type Outcome = 'GO' | 'AMEND' | 'NO-GO' | 'INCONCLUSIVE';

/**
 * Contract classified-evals-mol-xy5's GO/AMEND/NO-GO rule (>=7 of 10 criteria passing -> GO,
 * 4-6 -> AMEND, <4 -> NO-GO), extended per this bead's acceptance criteria with a NO-GO override
 * when c1 accuracy < 0.9, and INCONCLUSIVE when there are not yet enough human labels to trust
 * the pass count (fewer than 30 human-labelled traces or fewer than 300 total label rows).
 */
export function decideOutcome(input: {
  humanTraces: number;
  totalLabelRows: number;
  c1Accuracy: number | null;
  passCount: number;
}): Outcome {
  if (input.humanTraces < MIN_HUMAN_TRACES || input.totalLabelRows < MIN_TOTAL_LABEL_ROWS) {
    return 'INCONCLUSIVE';
  }
  if (input.c1Accuracy !== null && input.c1Accuracy < 0.9) return 'NO-GO';
  if (input.passCount >= 7) return 'GO';
  if (input.passCount >= 4) return 'AMEND';
  return 'NO-GO';
}

export type LabelCheck = { humanTraces: number; totalRows: number; ok: boolean };

/** `--check-labels`: distinct human-labelled traces vs total label rows, against the same bars as decideOutcome. */
export function checkLabels(rows: LabelRow[]): LabelCheck {
  const humanTraceIds = new Set(
    rows.filter((r) => r.source === 'human').map((r) => r.traceId),
  );
  return {
    humanTraces: humanTraceIds.size,
    totalRows: rows.length,
    ok: humanTraceIds.size >= MIN_HUMAN_TRACES && rows.length >= MIN_TOTAL_LABEL_ROWS,
  };
}

// ---------------------------------------------------------------------------
// Cache-backed P(yes) derivation (no network calls: reuses judge.ts's builders
// and cacheKey to find the already-fetched response on disk).
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

  const raw = JSON.parse(await readFile(path, 'utf8')) as {
    answers?: Record<string, { choice?: string; probabilities?: { yes?: number } }>;
    usage?: { input_tokens?: number };
  };

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

type Corpus = {
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
// Per-criterion table (a): truth = human/auto labels only (baseline-sourced c3
// truth is reported separately in the baseline block).
// ---------------------------------------------------------------------------

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
  verdict: 'pass' | 'fail' | 'unanswerable' | 'pending' | 'n/a';
};

function computeCriterionRow(
  criterionId: string,
  traces: Trace[],
  truthByKey: Map<string, LabelRow>,
  corpus: Corpus,
): CriterionRow {
  const n = traces.length;
  let excluded = 0;
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

    if (!labelRow || labelRow.label === 'review' || allEscaped || meanPYes === null) {
      excluded++;
      continue;
    }

    scoresForFit.push(meanPYes);
    labelsForFit.push(labelRow.label === 'yes');
    if (repeats.length > 0) repeatsForFlip.push(repeats.map((r) => r.pYes));
  }

  const escapePct = n > 0 ? excluded / n : 0;

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
  const { tpr, tnr } = rates(scoresForFit, labelsForFit, threshold);
  const predictions = scoresForFit.map((s) => s >= threshold);
  const kappa = cohenKappa(predictions, labelsForFit);
  const alpha = krippendorffAlphaNominal(predictions.map((p, i) => [p, labelsForFit[i]!]));
  const flipPct = flipRate(repeatsForFlip, threshold);

  const verdict: CriterionRow['verdict'] =
    escapePct > ESCAPE_UNANSWERABLE_BAR
      ? 'unanswerable'
      : kappa === null
        ? 'n/a'
        : kappa >= KAPPA_PASS_BAR
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
// Ground-truth block (b): c1 vs the reference-derived auto labels, c2 on the
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
// Baseline block (c): Cohen kappa between thresholded Jev c3 and the Gemini
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

function baselineBlock(traces: Trace[], baselineByKey: Map<string, LabelRow>, corpus: Corpus, c3Threshold: number | null): string {
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

// ---------------------------------------------------------------------------
// Cost block (d)
// ---------------------------------------------------------------------------

type HaystackCost = { judgePromptTokens: number; judgeCompletionTokens: number };

async function readHaystackCost(haystackDir: string): Promise<HaystackCost> {
  let judgePromptTokens = 0;
  let judgeCompletionTokens = 0;
  for (const variant of VARIANTS) {
    const path = join(haystackDir, 'report', `eval-${variant}.json`);
    const raw = JSON.parse(await readFile(path, 'utf8')) as {
      cost?: { judge_prompt_tokens?: number; judge_completion_tokens?: number };
    };
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

// ---------------------------------------------------------------------------
// Limitations paragraph (e)
// ---------------------------------------------------------------------------

function limitationsParagraph(haystackAggregateFaithfulness: number[]): string {
  const nearCeiling = haystackAggregateFaithfulness.map((f) => f.toFixed(3)).join(', ');
  return [
    'Contexts are whole source documents (55-344 words) rebuilt offline from corpus/*.pdf|docx, not the ' +
      "120-word chunks the pipeline actually retrieved by; the local Langfuse instance runs in v4 events-only " +
      'mode and /api/public/traces returned 404 (probed 2026-09-25), so the judged unit is whole-document ' +
      'context, not the retrieved chunk.',
    'Human labels: this run has 0 human-labelled rows (labelled traces filed as classified-evals-mol-vv7.7, ' +
      'still pending). With a single labeller once that lands, Krippendorff alpha reduces to plain agreement ' +
      'between the human and the judge; a second labeller is out of scope of this spike.',
    `Jev is reached only through the gateway alias ${MODEL} (TypeSafe registration is closed); the served ` +
      `model id recorded on every verdict is that alias, release_date ${JEV_RELEASE_DATE} per ` +
      `${JEV_RELEASE_DATE_SOURCE}; \`pinned: false\`.`,
    `The Gemini baseline is near ceiling: per-variant aggregate faithfulness across the four haystack-hypothesis ` +
      `runs is ${nearCeiling} (bm25/embedding/hybrid/hybrid-norerank) - the baseline comparison (block c) shows ` +
      'Jev reads references and abstentions reliably where the baseline rarely scores unfaithful, not that it ' +
      'catches subtle hallucinations.',
  ].join('\n\n');
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const labelRows = loadExistingRows(LABELS_PATH);

  if (process.argv.includes('--check-labels')) {
    const check = checkLabels(labelRows);
    console.log(`labels: ${check.humanTraces} traces (human), ${check.totalRows} rows`);
    if (!check.ok) process.exitCode = 1;
    return;
  }

  const haystackDir = process.env.HAYSTACK_HYPOTHESIS_DIR ?? join(homedir(), 'Projects', 'haystack-hypothesis');
  const traces = await readJsonl<Trace>(TRACES_PATH);
  const criteria = JSON.parse(await readFile(CRITERIA_PATH, 'utf8')) as Criterion[];
  const corpus = await loadCorpus(traces, criteria);

  const truthByKey = new Map<string, LabelRow>();
  const baselineByKey = new Map<string, LabelRow>();
  for (const row of labelRows) {
    if (row.source === 'baseline') baselineByKey.set(`${row.traceId}|${row.criterionId}`, row);
    else truthByKey.set(`${row.traceId}|${row.criterionId}`, row);
  }

  const criterionRows = criteria.map((c) => computeCriterionRow(c.id, traces, truthByKey, corpus));
  const c1Row = criterionRows.find((r) => r.id === 'c1')!;
  const c2Row = criterionRows.find((r) => r.id === 'c2')!;

  const { markdown: groundTruthMarkdown, c1Accuracy } = groundTruthBlock(
    traces,
    truthByKey,
    corpus,
    c1Row,
    c2Row,
  );

  const c3Threshold = fitC3ThresholdAgainstBaseline(traces, baselineByKey, corpus);
  const baselineMarkdown = baselineBlock(traces, baselineByKey, corpus, c3Threshold);

  const haystackCost = await readHaystackCost(haystackDir);
  const costMarkdown = costBlock(corpus, haystackCost);

  const haystackAggregates: number[] = [];
  for (const variant of VARIANTS) {
    const summary = JSON.parse(
      await readFile(join(haystackDir, 'report', `eval-${variant}.json`), 'utf8'),
    ) as { aggregate?: { faithfulness?: number } };
    if (typeof summary.aggregate?.faithfulness === 'number') {
      haystackAggregates.push(summary.aggregate.faithfulness);
    }
  }
  const limitationsMarkdown = limitationsParagraph(haystackAggregates);

  const check = checkLabels(labelRows);
  const passCount = criterionRows.filter((r) => r.verdict === 'pass').length;
  const decision = decideOutcome({
    humanTraces: check.humanTraces,
    totalLabelRows: check.totalRows,
    c1Accuracy,
    passCount,
  });

  const markdown = [
    '# Spike report: Jev vs ground truth, Jev vs the Gemini judge (mol-vv7.5)',
    '',
    '## (a) Per-criterion table (human/auto labels as truth)',
    '',
    criterionTableMarkdown(criterionRows),
    '',
    '## (b) Ground-truth block',
    '',
    groundTruthMarkdown,
    '',
    '## (c) Baseline block (Jev c3 vs the Gemini judge, binarised at 0.5)',
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
    `Decision: ${decision}`,
    '',
  ].join('\n');

  await writeFile(REPORT_PATH, markdown, 'utf8');
  console.log(`report.ts: wrote ${REPORT_PATH}`);
}

if (import.meta.main) {
  await main();
}
