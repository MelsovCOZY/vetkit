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
import { readJsonl, renderInstructions } from './lib/index.ts';

export type Label = 'yes' | 'no' | 'review';
export type Source = 'auto' | 'human' | 'baseline' | 'model';

export type LabelRow = {
  traceId: string;
  criterionId: string;
  label: Label;
  source: Source;
  labelledAt: string;
  baseline: string;
};

export const CSV_HEADER = 'traceId,criterionId,label,source,labelledAt,baseline';

// The Kazakh suffix wildcard is `\p{L}*` (with the `u` flag) because JS `\w` is ASCII-only.
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
  return value === 'auto' || value === 'human' || value === 'baseline' || value === 'model';
}

export function serializeRow(row: LabelRow): string {
  return [row.traceId, row.criterionId, row.label, row.source, row.labelledAt, row.baseline].join(
    ',',
  );
}

export function parseCsv(text: string): LabelRow[] {
  const lines = text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
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
  const existingKeys = new Set(
    existing.map((r) => `${r.traceId}\u0000${r.criterionId}\u0000${r.source}`),
  );
  const rows: LabelRow[] = [];
  const counts: AutoCounts = { c1: { yes: 0, no: 0, review: 0 }, c2: { yes: 0, no: 0 }, c3: 0 };

  for (const t of traces) {
    const c1Label = compareAnswerToReference(t.answer, t.reference);
    counts.c1[c1Label] += 1;
    if (!existingKeys.has(`${t.traceId}\u0000c1\u0000auto`)) {
      rows.push({
        traceId: t.traceId,
        criterionId: 'c1',
        label: c1Label,
        source: 'auto',
        labelledAt: now(),
        baseline: '',
      });
    }

    const c2Label = computeC2Label(t.answer, t.unanswerable);
    counts.c2[c2Label] += 1;
    if (!existingKeys.has(`${t.traceId}\u0000c2\u0000auto`)) {
      rows.push({
        traceId: t.traceId,
        criterionId: 'c2',
        label: c2Label,
        source: 'auto',
        labelledAt: now(),
        baseline: '',
      });
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
    // Swap via splice: arr[i] and arr[j] read as T | undefined under noUncheckedIndexedAccess.
    const moved = arr.splice(j, 1, ...arr.slice(i, i + 1));
    arr.splice(i, 1, ...moved);
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
  const langs = [...byLang.keys()].toSorted();
  const perLang = Math.ceil(minSize / Math.max(langs.length, 1));
  const picked: Trace[] = [];
  for (const lang of langs) {
    picked.push(...seededShuffle(byLang.get(lang) ?? [], seed).slice(0, perLang));
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
    existing
      .filter((r) => r.source === 'auto' && r.criterionId === 'c1')
      .map((r) => [r.traceId, r]),
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

export type PendingItem = {
  id: string;
  traceId: string;
  criterionId: string;
  question: string;
  answer: string;
  contexts: { docId: string; text: string }[];
  criterion: { name: string; instructions: string; escape: string };
  labels: Label[];
};

const ALLOWED_LABELS: Label[] = ['yes', 'no', 'review'];

/**
 * The blind items a model labeller is asked, from the loop's own `buildQueue`. Carries exactly
 * what the TTY loop prints (question, contexts, answer, criterion wording): never a judge
 * verdict, baseline, auto label or reference. Model rows are ignored when selecting so the set
 * stays stable across imports; items already model-labelled are then dropped from the export.
 */
export function buildPendingItems(
  traces: Trace[],
  criteria: Criterion[],
  existing: LabelRow[],
  sampleTraceIds: string[],
): PendingItem[] {
  const traceById = new Map(traces.map((t) => [t.traceId, t]));
  const criterionById = new Map(criteria.map((c) => [c.id, c]));
  const modelKeys = new Set(
    existing.filter((r) => r.source === 'model').map((r) => `${r.traceId}\u0000${r.criterionId}`),
  );
  const queue = buildQueue(
    traces,
    criteria,
    existing.filter((r) => r.source !== 'model'),
    sampleTraceIds,
  );
  const items: PendingItem[] = [];
  for (const { traceId, criterionId } of queue) {
    const t = traceById.get(traceId);
    const c = criterionById.get(criterionId);
    if (!t || !c || modelKeys.has(`${traceId}\u0000${criterionId}`)) continue;
    items.push({
      id: `${traceId}:${criterionId}`,
      traceId,
      criterionId,
      question: t.question,
      answer: t.answer,
      contexts: t.contexts.map((ctx) => ({ docId: ctx.docId, text: ctx.text })),
      criterion: { name: c.name, instructions: renderInstructions(c, t), escape: c.escape },
      labels: [...ALLOWED_LABELS],
    });
  }
  return items;
}

/**
 * Validates a JSONL of `{id, label}` model answers against the pending ids. Unknown ids, labels
 * outside yes/no/review, malformed lines and any explicit source other than 'model' are rejected;
 * ids already labelled by a model are skipped, so re-importing is a no-op.
 */
export function importModelRows(
  text: string,
  pendingIds: Set<string>,
  existing: LabelRow[],
  now: () => string = () => new Date().toISOString(),
): { toAppend: LabelRow[]; skipped: number; rejected: number } {
  const done = new Set(
    existing.filter((r) => r.source === 'model').map((r) => `${r.traceId}:${r.criterionId}`),
  );
  const toAppend: LabelRow[] = [];
  let skipped = 0;
  let rejected = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let parsed: { id?: unknown; label?: unknown; source?: unknown };
    try {
      parsed = JSON.parse(line);
    } catch {
      rejected += 1;
      continue;
    }
    const { id, label, source } = parsed ?? {};
    if (
      typeof id !== 'string' ||
      !pendingIds.has(id) ||
      typeof label !== 'string' ||
      !isLabel(label) ||
      (source !== undefined && source !== 'model')
    ) {
      rejected += 1;
      continue;
    }
    if (done.has(id)) {
      skipped += 1;
      continue;
    }
    done.add(id);
    const sep = id.lastIndexOf(':');
    toAppend.push({
      traceId: id.slice(0, sep),
      criterionId: id.slice(sep + 1),
      label,
      source: 'model',
      labelledAt: now(),
      baseline: '',
    });
  }
  return { toAppend, skipped, rejected };
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

    opts.print(`${c.name}: ${renderInstructions(c, t)} (escape: ${c.escape}) [y/n/u/q]`);
    const raw = (await opts.ask('> ')).trim().toLowerCase();
    if (raw === 'q') return { answered, quit: true };

    const label: Label = raw === 'y' ? 'yes' : raw === 'n' ? 'no' : 'review';
    opts.onRow({
      traceId: t.traceId,
      criterionId: c.id,
      label,
      source: 'human',
      labelledAt: now(),
      baseline: '',
    });
    answered += 1;
  }

  return { answered, quit: false };
}

export function validateImportRow(
  row: LabelRow,
  traceIds: Set<string>,
  criterionIds: Set<string>,
): boolean {
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
  const existingKeys = new Set(
    existing.map((r) => `${r.traceId}\u0000${r.criterionId}\u0000${r.source}`),
  );
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
  | { mode: 'import-model'; path: string }
  | { mode: 'export-pending'; path: string }
  | { mode: 'interactive' }
  | { mode: 'exit2' };

export function resolveMode(argv: string[], isTTY: boolean): Mode {
  if (argv.includes('--auto')) return { mode: 'auto' };
  const exportIdx = argv.indexOf('--export-pending');
  if (exportIdx !== -1) {
    const path = argv[exportIdx + 1];
    return path ? { mode: 'export-pending', path } : { mode: 'exit2' };
  }
  const importIdx = argv.indexOf('--import');
  if (importIdx !== -1) {
    const path = argv[importIdx + 1];
    if (!path) return { mode: 'exit2' };
    const sourceIdx = argv.indexOf('--source');
    if (sourceIdx === -1) return { mode: 'import', path };
    return argv[sourceIdx + 1] === 'model' ? { mode: 'import-model', path } : { mode: 'exit2' };
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
  const criteria: Criterion[] = JSON.parse(readFileSync(CRITERIA_PATH, 'utf8'));
  return criteria;
}

async function main(): Promise<void> {
  const mode = resolveMode(process.argv.slice(2), process.stdin.isTTY);

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

  if (mode.mode === 'export-pending' || mode.mode === 'import-model') {
    const criteria = await loadCriteria();
    const existing = loadExistingRows(LABELS_PATH);
    const items = buildPendingItems(
      traces,
      criteria,
      existing,
      selectSample(traces, SAMPLE_SEED, SAMPLE_MIN_SIZE),
    );
    if (mode.mode === 'export-pending') {
      writeFileSync(mode.path, items.map((i) => JSON.stringify(i)).join('\n') + '\n');
      const langOf = new Map(traces.map((t) => [t.traceId, t.lang]));
      const tally = (keyOf: (i: PendingItem) => string | undefined): string => {
        const counts = new Map<string, number>();
        for (const i of items) counts.set(keyOf(i) ?? '?', (counts.get(keyOf(i) ?? '?') ?? 0) + 1);
        return [...counts]
          .toSorted(([a], [b]) => a.localeCompare(b))
          .map(([k, n]) => `${k}=${n}`)
          .join(' ');
      };
      console.log(`exported: ${items.length}`);
      console.log(`by criterion: ${tally((i) => i.criterionId)}`);
      console.log(`by lang: ${tally((i) => langOf.get(i.traceId))}`);
      return;
    }
    // Pending ids include already model-labelled items (stable set) so re-imports skip, not reject.
    const pendingIds = new Set(
      buildPendingItems(
        traces,
        criteria,
        existing.filter((r) => r.source !== 'model'),
        selectSample(traces, SAMPLE_SEED, SAMPLE_MIN_SIZE),
      ).map((i) => i.id),
    );
    const { toAppend, skipped, rejected } = importModelRows(
      readFileSync(mode.path, 'utf8'),
      pendingIds,
      existing,
    );
    appendRows(LABELS_PATH, toAppend);
    console.log(`imported: ${toAppend.length}, skipped: ${skipped}, rejected: ${rejected}`);
    if (rejected > 0) process.exitCode = 1;
    return;
  }

  if (mode.mode === 'import') {
    const criteria = await loadCriteria();
    const traceIds = new Set(traces.map((t) => t.traceId));
    const criterionIds = new Set(criteria.map((c) => c.id));
    const existing = loadExistingRows(LABELS_PATH);
    const importRows = parseCsv(readFileSync(mode.path, 'utf8'));
    const { toAppend, imported, rejected } = mergeImport(
      importRows,
      existing,
      traceIds,
      criterionIds,
    );
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
  void main();
}
