// Loads every *.jsonl file in a cases directory into validated Case[]. Each non-blank
// line goes through the spec chokepoint (safeParseJson + caseSchema). Failures are data,
// never throws, and carry the file and 1-based line number.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CEV_ERROR_CODES,
  caseSchema,
  safeParseJson,
  type Case,
  type CevErrorCode,
} from '@vetkit/spec';

export interface CaseLocation {
  readonly file: string;
  readonly line: number;
}

export interface CaseIssue extends CaseLocation {
  readonly code: CevErrorCode;
  readonly message: string;
  /** The other location of a duplicate id. */
  readonly related?: CaseLocation;
}

export type LoadCasesResult =
  | { readonly ok: true; readonly cases: Case[] }
  | { readonly ok: false; readonly issues: CaseIssue[] };

/** Load-time token budget for `input.state`, estimated as chars/4. */
export const MAX_STATE_TOKENS = 32_000;

function describeCause(cause: unknown): string | undefined {
  if (!Array.isArray(cause)) return undefined;
  const [first]: unknown[] = cause;
  if (typeof first !== 'object' || first === null) return undefined;
  const { instancePath, message } = first as { instancePath?: unknown; message?: unknown };
  if (typeof message !== 'string') return undefined;
  return typeof instancePath === 'string' && instancePath !== ''
    ? `${instancePath} ${message}`
    : message;
}

// vet cases quarantine moves a case's line into <dir>/quarantine.jsonl; excluding
// it here is what makes `vet run` (which loads cases through this same function) skip
// quarantined cases.
const QUARANTINE_FILE = 'quarantine.jsonl';

export async function loadCases(dir: string): Promise<LoadCasesResult> {
  let names: string[];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    names = entries
      .filter(
        (entry) =>
          entry.isFile() && entry.name.endsWith('.jsonl') && entry.name !== QUARANTINE_FILE,
      )
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
          message: `cannot read ${dir}: ${String(cause)}`,
        },
      ],
    };
  }

  const issues: CaseIssue[] = [];
  const cases: Case[] = [];
  const firstById = new Map<string, CaseLocation>();

  for (const name of names) {
    const file = join(dir, name);
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (cause) {
      issues.push({
        code: CEV_ERROR_CODES.E_IO,
        file,
        line: 0,
        message: `cannot read: ${String(cause)}`,
      });
      continue;
    }

    for (const [index, raw] of text.split(/\r?\n/).entries()) {
      if (raw.trim() === '') continue;
      const location: CaseLocation = { file, line: index + 1 };

      const parsed = safeParseJson<Case>(raw, caseSchema);
      if (!parsed.ok) {
        issues.push({
          code: CEV_ERROR_CODES.CASE_INVALID,
          ...location,
          message: describeCause(parsed.error.cause) ?? parsed.error.message,
        });
        continue;
      }
      const value = parsed.value;

      const first = firstById.get(value.id);
      if (first !== undefined) {
        issues.push({
          code: CEV_ERROR_CODES.CASE_INVALID,
          ...location,
          related: first,
          message: `duplicate case id '${value.id}' (first defined at ${first.file}:${first.line})`,
        });
        continue;
      }
      firstById.set(value.id, location);

      const tokens = Math.ceil(value.input.state.length / 4);
      if (tokens > MAX_STATE_TOKENS) {
        issues.push({
          code: CEV_ERROR_CODES.INPUT_TOO_LARGE,
          ...location,
          message: `case '${value.id}': input.state is ~${tokens} tokens (chars/4), over the ${MAX_STATE_TOKENS} limit`,
        });
        continue;
      }
      cases.push(value);
    }
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true, cases };
}
