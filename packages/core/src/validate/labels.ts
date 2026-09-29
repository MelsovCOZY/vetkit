// Human labels: `evals/labels/<criterion_id>.csv` with columns
// case_id,criterion_id,label,labeler,labeled_at.
// A plain CSV so any spreadsheet can produce them. Failures are data, never throws;
// each carries the file and the 1-based line.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CEV_ERROR_CODES, validateJson, type CevErrorCode, type JsonSchema } from '@vetkit/spec';

export type LabelValue = 'pass' | 'fail' | 'unknown';

export interface LabelRow {
  readonly caseId: string;
  readonly criterionId: string;
  readonly label: LabelValue;
  readonly labeler: string;
  readonly labeledAt: string;
}

export type LabelEntry = Omit<LabelRow, 'criterionId'>;

/** criterionId → its labels, in file order (last duplicate wins). */
export type LabelSet = Map<string, LabelEntry[]>;

export interface LabelIssue {
  readonly code: CevErrorCode;
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

export interface LabelWarning {
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

export interface LabelIdSets {
  readonly caseIds?: ReadonlySet<string>;
  readonly criterionIds?: ReadonlySet<string>;
}

export type ParseLabelsResult =
  | { readonly ok: true; readonly rows: LabelRow[]; readonly warnings: LabelWarning[] }
  | { readonly ok: false; readonly issues: LabelIssue[] };

export type LoadLabelsResult =
  | { readonly ok: true; readonly labels: LabelSet; readonly warnings: LabelWarning[] }
  | { readonly ok: false; readonly issues: LabelIssue[] };

export interface CsvRecord {
  readonly line: number;
  readonly fields: string[];
}

const COLUMNS = ['case_id', 'criterion_id', 'label', 'labeler', 'labeled_at'] as const;
type Column = (typeof COLUMNS)[number];

export const LABEL_CSV_HEADER: string = COLUMNS.join(',');

const nonEmpty = { type: 'string', minLength: 1 };
const rowSchema: JsonSchema = {
  type: 'object',
  required: [...COLUMNS],
  additionalProperties: false,
  properties: {
    case_id: nonEmpty,
    criterion_id: nonEmpty,
    label: { enum: ['pass', 'fail', 'unknown'] },
    labeler: nonEmpty,
    labeled_at: nonEmpty,
  },
};

type RawRow = Record<Exclude<Column, 'label'>, string> & { readonly label: LabelValue };

/** RFC 4180 reader: quoted fields, `""` escapes, CRLF or LF, blank lines skipped. */
export function parseCsv(text: string): CsvRecord[] {
  const records: CsvRecord[] = [];
  let fields: string[] = [];
  let field = '';
  let quoted = false;
  let line = 1;
  let start = 1;
  let dirty = false;
  const endRecord = (): void => {
    fields.push(field);
    if (dirty) records.push({ line: start, fields });
    fields = [];
    field = '';
    dirty = false;
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        if (ch === '\n') line += 1;
        field += ch;
      }
      continue;
    }
    if (ch === '\r' && text[i + 1] === '\n') continue;
    if (ch === '\n') {
      endRecord();
      line += 1;
      start = line;
      continue;
    }
    dirty = true;
    if (ch === '"') quoted = true;
    else if (ch === ',') {
      fields.push(field);
      field = '';
    } else field += ch;
  }
  endRecord();
  return records;
}

function quote(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** One CSV line (no newline) in LABEL_CSV_HEADER column order. */
export function formatLabelRow(row: LabelRow): string {
  return [row.caseId, row.criterionId, row.label, row.labeler, row.labeledAt].map(quote).join(',');
}

function issue(file: string, line: number, message: string): LabelIssue {
  return { code: CEV_ERROR_CODES.LABELS_INVALID, file, line, message };
}

function checkIds(row: RawRow, ids: LabelIdSets): string | undefined {
  if (ids.caseIds !== undefined && !ids.caseIds.has(row.case_id)) {
    return `unknown case id '${row.case_id}' (not in the cases directory)`;
  }
  if (ids.criterionIds !== undefined && !ids.criterionIds.has(row.criterion_id)) {
    return `unknown criterion id '${row.criterion_id}' (not in the criteria file)`;
  }
  return undefined;
}

export function parseLabels(text: string, file: string, ids: LabelIdSets = {}): ParseLabelsResult {
  const [header, ...records] = parseCsv(text);
  const names = header?.fields.map((name) => name.trim()) ?? [];
  const missing = COLUMNS.filter((column) => !names.includes(column));
  if (missing.length > 0) {
    return {
      ok: false,
      issues: [
        issue(file, header?.line ?? 1, `header is missing column(s): ${missing.join(', ')}`),
      ],
    };
  }

  const issues: LabelIssue[] = [];
  const warnings: LabelWarning[] = [];
  const byKey = new Map<string, { row: LabelRow; line: number }>();
  for (const record of records) {
    if (record.fields.length !== names.length) {
      issues.push(
        issue(file, record.line, `expected ${names.length} fields, got ${record.fields.length}`),
      );
      continue;
    }
    const raw = Object.fromEntries(
      names.flatMap((name, index) =>
        (COLUMNS as readonly string[]).includes(name) ? [[name, record.fields[index]]] : [],
      ),
    );
    const parsed = validateJson<RawRow>(raw, rowSchema);
    if (!parsed.ok) {
      issues.push(issue(file, record.line, `invalid row: ${parsed.error.message}`));
      continue;
    }
    const idProblem = checkIds(parsed.value, ids);
    if (idProblem !== undefined) {
      issues.push(issue(file, record.line, idProblem));
      continue;
    }
    const { case_id, criterion_id, label, labeler, labeled_at } = parsed.value;
    const row: LabelRow = {
      caseId: case_id,
      criterionId: criterion_id,
      label,
      labeler,
      labeledAt: labeled_at,
    };
    const key = `${criterion_id}\u0000${case_id}`;
    const previous = byKey.get(key);
    if (previous !== undefined) {
      warnings.push({
        file,
        line: record.line,
        message: `duplicate label for case '${case_id}', criterion '${criterion_id}' (also at line ${previous.line}); last wins`,
      });
      byKey.delete(key);
    }
    byKey.set(key, { row, line: record.line });
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, rows: [...byKey.values()].map((entry) => entry.row), warnings };
}

/** Reads every *.csv in `dir` into a LabelSet keyed by criterion id. */
export async function loadLabels(dir: string, ids: LabelIdSets = {}): Promise<LoadLabelsResult> {
  let names: string[];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    names = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.csv'))
      .map((entry) => entry.name)
      .toSorted();
  } catch (cause) {
    return {
      ok: false,
      issues: [
        {
          code: CEV_ERROR_CODES.E_IO,
          file: dir,
          line: 0,
          message: `cannot read: ${String(cause)}`,
        },
      ],
    };
  }

  const issues: LabelIssue[] = [];
  const warnings: LabelWarning[] = [];
  const rows: LabelRow[] = [];
  for (const name of names) {
    const file = join(dir, name);
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (cause) {
      issues.push({ code: CEV_ERROR_CODES.E_IO, file, line: 0, message: String(cause) });
      continue;
    }
    const result = parseLabels(text, file, ids);
    if (result.ok) {
      rows.push(...result.rows);
      warnings.push(...result.warnings);
    } else issues.push(...result.issues);
  }
  if (issues.length > 0) return { ok: false, issues };

  const labels: LabelSet = new Map();
  for (const { criterionId, ...entry } of rows) {
    const list = labels.get(criterionId) ?? [];
    const at = list.findIndex((existing) => existing.caseId === entry.caseId);
    if (at !== -1) list.splice(at, 1);
    list.push(entry);
    labels.set(criterionId, list);
  }
  return { ok: true, labels, warnings };
}
