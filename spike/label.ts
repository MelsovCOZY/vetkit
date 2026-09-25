import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as clack from '@clack/prompts';
import type { Trace } from './corpus.ts';
import type { Criterion } from './propose.ts';
import { readJsonl } from './lib/index.ts';

export type Label = 'yes' | 'no' | 'review';
export type Source = 'auto' | 'human' | 'baseline';

export type LabelRow = {
  traceId: string;
  criterionId: string;
  label: Label;
  source: Source;
  labelledAt: string;
  baseline: string;
};

export const CSV_HEADER = 'traceId,criterionId,label,source,labelledAt,baseline';

// Ported from ~/Projects/haystack-hypothesis/src/probe/eval_judge.py `_ABSTENTION`.
// Python's `\w*` is Unicode-aware by default; JS `\w` is ASCII-only, so the Kazakh
// suffix wildcard is ported as `\p{L}*` (with the `u` flag) instead.
const ABSTENTION_RE =
  /no evidence|no information|not enough information|insufficient information|cannot (?:be )?found?|not (?:mentioned|found|provided|available)|does not (?:say|contain|mention)|нет (?:информации|данных|сведений|подтверждени)|не (?:найден|указан|упоминается)|недостаточно (?:информации|данных)|(?:ақпарат|мәлімет|дерек)\p{L}* жоқ|табылмады|көрсетілмеген/iu;

export function isAbstention(text: string): boolean {
  return ABSTENTION_RE.test(text ?? '');
}

const MAGNITUDE_RE = /(\d+(?:\.\d+)?)\s*(million|thousand|billion|млн|тыс|млрд)(?!\p{L})/giu;
const MAGNITUDE_MULTIPLIER: Record<string, number> = {
  million: 1_000_000,
  thousand: 1_000,
  billion: 1_000_000_000,
  млн: 1_000_000,
  тыс: 1_000,
  млрд: 1_000_000_000,
};

function stripThousandsSeparators(text: string): string {
  let current = text;
  for (;;) {
    const next = current.replace(/(\d)[,\s](\d{3})(?!\d)/g, '$1$2');
    if (next === current) return current;
    current = next;
  }
}

function expandMagnitudeWords(text: string): string {
  return text.replace(MAGNITUDE_RE, (_match, digits: string, unit: string) => {
    const multiplier = MAGNITUDE_MULTIPLIER[unit.toLowerCase()] ?? 1;
    return String(Math.round(Number.parseFloat(digits) * multiplier));
  });
}

/** Folds case/punctuation/number-format so a reference can be compared as a substring. */
export function normalizeForCompare(text: string): string {
  const lower = (text ?? '').toLowerCase();
  const noCitations = lower.replace(/\[\d+\]/g, ' ');
  const noThousands = stripThousandsSeparators(noCitations);
  const expanded = expandMagnitudeWords(noThousands);
  const noPunctuation = expanded.replace(/[^\p{L}\p{N}\s]/gu, ' ');
  return noPunctuation.replace(/\s+/g, ' ').trim();
}

function extractNumbers(text: string): Set<string> {
  return new Set(text.match(/\d+/g) ?? []);
}

/**
 * c1 ground truth: normalised reference is a substring of the normalised answer -> yes.
 * A shared number token without a full match (e.g. differing formats) -> review, for human
 * confirmation. No reference (unanswerable rows) -> review (escape: "reference not comparable").
 */
export function compareAnswerToReference(answer: string, reference: string | null): Label {
  if (reference === null || reference.trim() === '') return 'review';
  const normRef = normalizeForCompare(reference);
  const normAns = normalizeForCompare(answer);
  if (normRef.length > 0 && normAns.includes(normRef)) return 'yes';
  const refNumbers = extractNumbers(normRef);
  if (refNumbers.size > 0) {
    const ansNumbers = extractNumbers(normAns);
    for (const n of refNumbers) {
      if (ansNumbers.has(n)) return 'review';
    }
  }
  return 'no';
}

/** c2 ground truth: correct behaviour is abstaining iff the question is golden-unanswerable. */
export function computeC2Label(answer: string, unanswerable: boolean): 'yes' | 'no' {
  return isAbstention(answer) === unanswerable ? 'yes' : 'no';
}

/** c3 baseline: the Gemini plain-mode judge score, thresholded at >= 0.5 (never a human label). */
export function computeC3Baseline(faithfulness: number): { label: 'yes' | 'no'; baseline: string } {
  return { label: faithfulness >= 0.5 ? 'yes' : 'no', baseline: String(faithfulness) };
}

function isLabel(value: string | undefined): value is Label {
  return value === 'yes' || value === 'no' || value === 'review';
}

function isSource(value: string | undefined): value is Source {
  return value === 'auto' || value === 'human' || value === 'baseline';
}

export function serializeRow(row: LabelRow): string {
  return [row.traceId, row.criterionId, row.label, row.source, row.labelledAt, row.baseline].join(',');
}

export function parseCsv(text: string): LabelRow[] {
  const lines = text.split('\n').map((line) => line.trimEnd()).filter((line) => line.length > 0);
  const body = lines[0] === CSV_HEADER ? lines.slice(1) : lines;
  const rows: LabelRow[] = [];
  for (const line of body) {
    const [traceId, criterionId, label, source, labelledAt, baseline] = line.split(',');
    if (!traceId || !criterionId || !isLabel(label) || !isSource(source) || !labelledAt) continue;
    rows.push({ traceId, criterionId, label, source, labelledAt, baseline: baseline ?? '' });
  }
  return rows;
}

export function loadExistingRows(path: string): LabelRow[] {
  if (!existsSync(path)) return [];
  return parseCsv(readFileSync(path, 'utf8'));
}

/** Appends rows one at a time, fsyncing after each so Ctrl-C mid-loop loses nothing. */
export function appendRows(path: string, rows: LabelRow[]): void {
  if (rows.length === 0) return;
  if (!existsSync(path)) writeFileSync(path, `${CSV_HEADER}\n`);
  const fd = openSync(path, 'a');
  try {
    for (const row of rows) {
      writeSync(fd, `${serializeRow(row)}\n`);
      fsyncSync(fd);
    }
  } finally {
    closeSync(fd);
  }
}

export type AutoCounts = {
  c1: { yes: number; no: number; review: number };
  c2: { yes: number; no: number };
  c3: number;
};

/** Computes c1/c2/c3 rows for every trace; skips (traceId,criterionId,source) triples already in `existing`. */
export function runAuto(
  traces: Trace[],
  existing: LabelRow[],
  now: () => string = () => new Date().toISOString(),
): { rows: LabelRow[]; counts: AutoCounts } {
  const existingKeys = new Set(existing.map((r) => `${r.traceId}\u0000${r.criterionId}\u0000${r.source}`));
  const rows: LabelRow[] = [];
  const counts: AutoCounts = { c1: { yes: 0, no: 0, review: 0 }, c2: { yes: 0, no: 0 }, c3: 0 };

  for (const t of traces) {
    const c1Label = compareAnswerToReference(t.answer, t.reference);
    counts.c1[c1Label] += 1;
    if (!existingKeys.has(`${t.traceId}\u0000c1\u0000auto`)) {
      rows.push({ traceId: t.traceId, criterionId: 'c1', label: c1Label, source: 'auto', labelledAt: now(), baseline: '' });
    }

    const c2Label = computeC2Label(t.answer, t.unanswerable);
    counts.c2[c2Label] += 1;
    if (!existingKeys.has(`${t.traceId}\u0000c2\u0000auto`)) {
      rows.push({ traceId: t.traceId, criterionId: 'c2', label: c2Label, source: 'auto', labelledAt: now(), baseline: '' });
    }

    const c3 = computeC3Baseline(t.baseline.faithfulness);
    counts.c3 += 1;
    if (!existingKeys.has(`${t.traceId}\u0000c3\u0000baseline`)) {
      rows.push({
        traceId: t.traceId,
        criterionId: 'c3',
        label: c3.label,
        source: 'baseline',
        labelledAt: now(),
        baseline: c3.baseline,
      });
    }
  }

  return { rows, counts };
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const arr = items.slice();
  const rand = mulberry32(seed);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
  return arr;
}

/** A seeded, language-stratified sample of at least `minSize` trace ids. */
export function selectSample(traces: Trace[], seed: number, minSize: number): string[] {
  const byLang = new Map<string, Trace[]>();
  for (const t of traces) {
    const group = byLang.get(t.lang) ?? [];
    group.push(t);
    byLang.set(t.lang, group);
  }
  const langs = [...byLang.keys()].sort();
  const perLang = Math.ceil(minSize / Math.max(langs.length, 1));
  const picked: Trace[] = [];
  for (const lang of langs) {
    picked.push(...seededShuffle(byLang.get(lang)!, seed).slice(0, perLang));
  }
  return seededShuffle(picked, seed + 1).map((t) => t.traceId);
}

/** Queue order: unresolved c1 "review" rows first, then c3 + generated criteria on the sample. */
export function buildQueue(
  traces: Trace[],
  criteria: Criterion[],
  existing: LabelRow[],
  sampleTraceIds: string[],
): { traceId: string; criterionId: string }[] {
  const humanKeys = new Set(
    existing.filter((r) => r.source === 'human').map((r) => `${r.traceId}\u0000${r.criterionId}`),
  );
  const autoC1ByTrace = new Map(
    existing.filter((r) => r.source === 'auto' && r.criterionId === 'c1').map((r) => [r.traceId, r]),
  );
  const queue: { traceId: string; criterionId: string }[] = [];

  for (const t of traces) {
    const auto = autoC1ByTrace.get(t.traceId);
    if (auto?.label === 'review' && !humanKeys.has(`${t.traceId}\u0000c1`)) {
      queue.push({ traceId: t.traceId, criterionId: 'c1' });
    }
  }

  const sampleCriteria = criteria.filter((c) => c.id !== 'c1' && c.id !== 'c2');
  for (const traceId of sampleTraceIds) {
    for (const c of sampleCriteria) {
      if (!humanKeys.has(`${traceId}\u0000${c.id}`)) queue.push({ traceId, criterionId: c.id });
    }
  }

  return queue;
}

export type AskFn = (message: string) => Promise<string>;
export type PrintFn = (message: string) => void;

/**
 * Drives the blind labelling loop over `queue`. Prints each trace's question/contexts/answer
 * once, then each criterion's instructions; never reads or prints a judge verdict or baseline
 * score. `onRow` is called once per answered item so the caller can append-and-fsync immediately.
 */
export async function runInteractiveLoop(opts: {
  queue: { traceId: string; criterionId: string }[];
  traces: Trace[];
  criteria: Criterion[];
  ask: AskFn;
  print: PrintFn;
  onRow: (row: LabelRow) => void;
  now?: () => string;
}): Promise<{ answered: number; quit: boolean }> {
  const traceById = new Map(opts.traces.map((t) => [t.traceId, t]));
  const criterionById = new Map(opts.criteria.map((c) => [c.id, c]));
  const now = opts.now ?? (() => new Date().toISOString());
  let answered = 0;
  let lastTraceId: string | null = null;

  for (const item of opts.queue) {
    const t = traceById.get(item.traceId);
    const c = criterionById.get(item.criterionId);
    if (!t || !c) continue;

    if (t.traceId !== lastTraceId) {
      opts.print(`Q: ${t.question}`);
      for (const ctx of t.contexts) opts.print(`[${ctx.docId}] ${ctx.text}`);
      opts.print(`A: ${t.answer}`);
      lastTraceId = t.traceId;
    }

    opts.print(`${c.name}: ${c.instructions} (escape: ${c.escape}) [y/n/u/q]`);
    const raw = (await opts.ask('> ')).trim().toLowerCase();
    if (raw === 'q') return { answered, quit: true };

    const label: Label = raw === 'y' ? 'yes' : raw === 'n' ? 'no' : 'review';
    opts.onRow({ traceId: t.traceId, criterionId: c.id, label, source: 'human', labelledAt: now(), baseline: '' });
    answered += 1;
  }

  return { answered, quit: false };
}

export function validateImportRow(row: LabelRow, traceIds: Set<string>, criterionIds: Set<string>): boolean {
  return (
    traceIds.has(row.traceId) &&
    criterionIds.has(row.criterionId) &&
    isLabel(row.label) &&
    isSource(row.source) &&
    row.labelledAt.length > 0
  );
}

/** Merges an imported CSV's rows: rejects invalid rows, dedupes by (traceId,criterionId,source). */
export function mergeImport(
  importRows: LabelRow[],
  existing: LabelRow[],
  traceIds: Set<string>,
  criterionIds: Set<string>,
): { toAppend: LabelRow[]; imported: number; rejected: number } {
  const existingKeys = new Set(existing.map((r) => `${r.traceId}\u0000${r.criterionId}\u0000${r.source}`));
  const lastWins = new Map<string, LabelRow>();
  let rejected = 0;

  for (const row of importRows) {
    if (!validateImportRow(row, traceIds, criterionIds)) {
      rejected += 1;
      continue;
    }
    lastWins.set(`${row.traceId}\u0000${row.criterionId}\u0000${row.source}`, row);
  }

  const toAppend: LabelRow[] = [];
  for (const [key, row] of lastWins) {
    if (existingKeys.has(key)) continue;
    toAppend.push(row);
  }

  return { toAppend, imported: toAppend.length, rejected };
}

export type Mode =
  | { mode: 'auto' }
  | { mode: 'import'; path: string }
  | { mode: 'interactive' }
  | { mode: 'exit2' };

export function resolveMode(argv: string[], isTTY: boolean): Mode {
  if (argv.includes('--auto')) return { mode: 'auto' };
  const importIdx = argv.indexOf('--import');
  if (importIdx !== -1) {
    const path = argv[importIdx + 1];
    return path ? { mode: 'import', path } : { mode: 'exit2' };
  }
  return isTTY ? { mode: 'interactive' } : { mode: 'exit2' };
}

const DATA_DIR = fileURLToPath(new URL('./data/', import.meta.url));
const TRACES_PATH = `${DATA_DIR}traces.jsonl`;
const CRITERIA_PATH = `${DATA_DIR}criteria.json`;
const LABELS_PATH = `${DATA_DIR}labels.csv`;
const SAMPLE_SEED = 20260925;
const SAMPLE_MIN_SIZE = 30;

async function loadCriteria(): Promise<Criterion[]> {
  return JSON.parse(readFileSync(CRITERIA_PATH, 'utf8')) as Criterion[];
}

async function main(): Promise<void> {
  const mode = resolveMode(process.argv.slice(2), Boolean(process.stdin.isTTY));

  if (mode.mode === 'exit2') {
    process.exitCode = 2;
    return;
  }

  const traces = await readJsonl<Trace>(TRACES_PATH);

  if (mode.mode === 'auto') {
    const existing = loadExistingRows(LABELS_PATH);
    const { rows, counts } = runAuto(traces, existing);
    appendRows(LABELS_PATH, rows);
    console.log(`c1: yes=${counts.c1.yes} no=${counts.c1.no} review=${counts.c1.review}`);
    console.log(`c2: yes=${counts.c2.yes} no=${counts.c2.no}`);
    console.log(`c3: baseline rows=${counts.c3}`);
    return;
  }

  if (mode.mode === 'import') {
    const criteria = await loadCriteria();
    const traceIds = new Set(traces.map((t) => t.traceId));
    const criterionIds = new Set(criteria.map((c) => c.id));
    const existing = loadExistingRows(LABELS_PATH);
    const importRows = parseCsv(readFileSync(mode.path, 'utf8'));
    const { toAppend, imported, rejected } = mergeImport(importRows, existing, traceIds, criterionIds);
    appendRows(LABELS_PATH, toAppend);
    console.log(`imported: ${imported}, rejected: ${rejected}`);
    return;
  }

  // interactive
  const criteria = await loadCriteria();
  const existing = loadExistingRows(LABELS_PATH);
  const sampleTraceIds = selectSample(traces, SAMPLE_SEED, SAMPLE_MIN_SIZE);
  const queue = buildQueue(traces, criteria, existing, sampleTraceIds);

  if (queue.length === 0) {
    clack.note('Nothing left to label.', 'label');
    return;
  }

  clack.intro('spike label loop (blind: no judge verdict or baseline shown)');
  await runInteractiveLoop({
    queue,
    traces,
    criteria,
    print: (m) => clack.note(m),
    ask: async (message) => String(await clack.text({ message })),
    onRow: (row) => appendRows(LABELS_PATH, [row]),
  });
  clack.outro('done');
}

if (import.meta.main) {
  main();
}
