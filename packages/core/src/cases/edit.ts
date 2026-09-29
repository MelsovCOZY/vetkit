// `vet cases dedupe|quarantine|promote|review` (bead classified-evals-mol-p4a.1). J1 (load.ts)
// leaves j1-5/j1-8; J7 (watch/promote.ts) leaf j7-3.
import { createHash, randomBytes } from 'node:crypto';
import { readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  caseSchema,
  CEV_ERROR_CODES,
  safeParseJson,
  VetError,
  type Case,
  type JsonSchema,
  type Verdict,
} from '@vetkit/spec';
import { appendLines } from '../outbox/files.ts';
import type { PromotedCase } from '../watch/types.ts';

const QUARANTINE_FILE = 'quarantine.jsonl';

// --- small filesystem primitives shared by the operations below --------------------------

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function listTopLevelJsonl(
  dir: string,
  exclude: ReadonlySet<string> = new Set(),
): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (cause) {
    if (isEnoent(cause)) return [];
    throw cause;
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.jsonl') && !exclude.has(e.name))
    .map((e) => join(dir, e.name))
    .toSorted();
}

async function readJsonlLines(file: string): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (cause) {
    if (isEnoent(cause)) return [];
    throw cause;
  }
  return text.split('\n').filter((line) => line.trim() !== '');
}

// Temp file + rename: a reader never sees a half-written file (same pattern as run-record.ts).
async function writeJsonlAtomic(file: string, lines: readonly string[]): Promise<void> {
  const tmp = `${file}.${String(process.pid)}.${randomBytes(4).toString('hex')}.tmp`;
  const body = lines.length === 0 ? '' : `${lines.join('\n')}\n`;
  try {
    await writeFile(tmp, body, 'utf8');
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

interface IdLine {
  readonly id: string;
}

// Looser than caseSchema (which is additionalProperties: false): a quarantined or promoted
// line carries an extra top-level field (`quarantine`), so id lookups go through this
// minimal schema instead (same pattern as watch/promote.ts's private ID_LINE_SCHEMA).
const ID_SCHEMA: JsonSchema = {
  type: 'object',
  properties: { id: { type: 'string' } },
  required: ['id'],
};

function parseId(raw: string): string | undefined {
  const parsed = safeParseJson<IdLine>(raw, ID_SCHEMA);
  return parsed.ok ? parsed.value.id : undefined;
}

interface Located {
  readonly file: string;
  readonly lines: string[];
  readonly index: number;
}

async function locateInFiles(files: readonly string[], id: string): Promise<Located | undefined> {
  for (const file of files) {
    // oxlint-disable-next-line no-await-in-loop
    const lines = await readJsonlLines(file);
    const index = lines.findIndex((raw) => parseId(raw) === id);
    if (index !== -1) return { file, lines, index };
  }
  return undefined;
}

function parseCaseLine(raw: string): Case {
  const parsed = safeParseJson<Case>(raw, caseSchema);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

// --- dedupe --------------------------------------------------------------------------------

/** sha256 of the trimmed `input.state`. Two cases with the same key are exact duplicates. */
export function dedupeKey(state: string): string {
  return createHash('sha256').update(state.trim()).digest('hex');
}

export interface DuplicatePair {
  readonly kept: string;
  readonly removed: string;
}

/** Groups cases by `dedupeKey`; within each group of 2+, the earliest id (ascending) is kept
 * and every other id is reported removed. */
export function findDuplicates(cases: readonly Case[]): DuplicatePair[] {
  const groups = new Map<string, Case[]>();
  for (const c of cases) {
    const key = dedupeKey(c.input.state);
    const group = groups.get(key);
    if (group) group.push(c);
    else groups.set(key, [c]);
  }
  const pairs: DuplicatePair[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const [keep, ...rest] = group.toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (keep === undefined) continue;
    for (const dup of rest) pairs.push({ kept: keep.id, removed: dup.id });
  }
  return pairs;
}

/** `--write`: removes the named ids from the cases dir's top-level *.jsonl files (never
 * quarantine.jsonl), rewriting only the files that actually changed. */
export async function removeCases(dir: string, ids: readonly string[]): Promise<void> {
  const remove = new Set(ids);
  if (remove.size === 0) return;
  const files = await listTopLevelJsonl(dir, new Set([QUARANTINE_FILE]));
  for (const file of files) {
    // oxlint-disable-next-line no-await-in-loop
    const lines = await readJsonlLines(file);
    const kept = lines.filter((raw) => {
      const id = parseId(raw);
      return id === undefined || !remove.has(id);
    });
    // oxlint-disable-next-line no-await-in-loop
    if (kept.length !== lines.length) await writeJsonlAtomic(file, kept);
  }
}

// --- quarantine ----------------------------------------------------------------------------

export interface QuarantineResult {
  readonly status: 'quarantined' | 'already_quarantined';
}

/** Moves case `id` from its top-level *.jsonl file into `<dir>/quarantine.jsonl`, adding
 * `quarantine: {reason, at}`. Appends to quarantine.jsonl before removing the source line
 * (crash-safe order: a crash in between still leaves the quarantine record). Already
 * quarantined is a no-op; not found anywhere throws CASE_INVALID. */
export async function quarantineCase(
  dir: string,
  id: string,
  reason: string,
  now: Date = new Date(),
): Promise<QuarantineResult> {
  const quarantineFile = join(dir, QUARANTINE_FILE);
  const existing = await readJsonlLines(quarantineFile);
  if (existing.some((raw) => parseId(raw) === id)) {
    return { status: 'already_quarantined' };
  }
  const files = await listTopLevelJsonl(dir, new Set([QUARANTINE_FILE]));
  const located = await locateInFiles(files, id);
  if (located === undefined) {
    throw new VetError(CEV_ERROR_CODES.CASE_INVALID, `case '${id}' not found in ${dir}`);
  }
  const found = parseCaseLine(located.lines[located.index] ?? '');
  await appendLines(quarantineFile, [{ ...found, quarantine: { reason, at: now.toISOString() } }]);
  const remaining = located.lines.filter((_, i) => i !== located.index);
  await writeJsonlAtomic(located.file, remaining);
  return { status: 'quarantined' };
}

// --- review (pending -> promoted or quarantine) ---------------------------------------------

export interface PendingCase {
  readonly file: string;
  readonly case: Case;
}

/** Every case under `<dir>/pending/*.jsonl` (auto-promoted by watch/promote.ts). */
export async function listPendingCases(dir: string): Promise<PendingCase[]> {
  const files = await listTopLevelJsonl(join(dir, 'pending'));
  const out: PendingCase[] = [];
  for (const file of files) {
    // oxlint-disable-next-line no-await-in-loop
    for (const raw of await readJsonlLines(file)) {
      const parsed = safeParseJson<Case>(raw, caseSchema);
      if (parsed.ok) out.push({ file, case: parsed.value });
    }
  }
  return out;
}

export interface ReviewOptions {
  readonly reason?: string;
  readonly now?: Date;
}

/** Moves pending case `id` into `<dir>/promoted-<date>.jsonl` (accept) or `<dir>/quarantine.jsonl`
 * with the reason (reject). Returns false when `id` isn't currently pending. */
export async function reviewCase(
  dir: string,
  id: string,
  action: 'accept' | 'reject',
  options: ReviewOptions = {},
): Promise<boolean> {
  const files = await listTopLevelJsonl(join(dir, 'pending'));
  const located = await locateInFiles(files, id);
  if (located === undefined) return false;
  const found = parseCaseLine(located.lines[located.index] ?? '');
  const now = options.now ?? new Date();
  if (action === 'accept') {
    await appendLines(join(dir, `promoted-${now.toISOString().slice(0, 10)}.jsonl`), [found]);
  } else {
    await appendLines(join(dir, QUARANTINE_FILE), [
      { ...found, quarantine: { reason: options.reason ?? '', at: now.toISOString() } },
    ]);
  }
  const remaining = located.lines.filter((_, i) => i !== located.index);
  await writeJsonlAtomic(located.file, remaining);
  return true;
}

// --- promote (manual, from a run verdict) ---------------------------------------------------

// watch/promote.ts's promoteFailure hardcodes its dayFile under <dir>/pending/ (auto-promotion
// from `vet watch`, dh8.3); this manual path (`vet cases promote <verdict-id>`) targets
// `<dir>/promoted-<date>.jsonl` directly, one level up, so a human-reviewed promotion never
// needs a second `vet cases review` pass. promote.ts is not editable to take a target dir
// (not this bead's owned path), so the small id/provenance shape it builds is duplicated here
// rather than imported.
export async function promoteVerdict(
  dir: string,
  verdict: Verdict,
  evalCase: Case,
  now: Date = new Date(),
): Promise<PromotedCase | undefined> {
  if (verdict.status !== 'ok' || verdict.pass !== false) return undefined;
  if (evalCase.traceId === undefined) return undefined;
  if (verdict.id === undefined) return undefined;

  const promoted: PromotedCase = {
    ...evalCase,
    id: `promoted-${evalCase.traceId}-${verdict.criterionId}`,
    provenance: {
      ...(isRecord(evalCase.provenance) ? evalCase.provenance : {}),
      promotedFrom: {
        traceId: evalCase.traceId,
        criterionId: verdict.criterionId,
        verdictId: verdict.id,
        at: now.toISOString(),
      },
    },
  };
  await appendLines(join(dir, `promoted-${now.toISOString().slice(0, 10)}.jsonl`), [promoted]);
  return promoted;
}
