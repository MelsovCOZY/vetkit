// The persisted result of a `vet run`: the runEvals result as `vet run --json` prints it, plus
// where its criteria and cases came from (paths relative to the config directory, POSIX
// separators, so a record copied to another checkout still makes sense) and when it started.
// Each run writes <cacheDir>/runs/<stamp>.json; <cacheDir>/runs/latest.json is a byte-identical
// copy of the newest one (a plain file, not a symlink: symlinks do not survive the GitHub Actions
// cache or Windows checkouts, and consumers read it as a full record). Old per-run files are
// never pruned; .vet/ is gitignored. Two runs starting in the same millisecond share a stamp, so
// the second replaces the first. Every file is written through a temp file and rename so a reader
// never sees half a record.
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CEV_ERROR_CODES,
  redactSecretsDeep,
  runRecordSchema,
  safeParseJson,
  secretsFrom,
  validateJson,
  VetError,
} from '@vetkit/spec';
import type { GateLabel, RunEvalsResult } from './run.ts';

export interface RunRecord extends Omit<RunEvalsResult, 'gate'> {
  /** Stamped by writeRunRecord: the run-record schema `$id`. */
  $schema: string;
  /** Absent in records written by `vet rerun` and by versions before the gate label. */
  gate?: GateLabel;
  /** Relative to the config directory, POSIX separators. */
  criteriaPath: string;
  /** Relative to the config directory, POSIX separators. */
  casesPath: string;
  /** ISO 8601 time the run started. */
  startedAt: string;
  /** Whether `--gate` was passed (`vet rerun` never gates). */
  gateRequested: boolean;
}

const RUNS_DIR = 'runs';

async function writeAtomic(path: string, text: string): Promise<void> {
  const tmp = `${path}.${String(process.pid)}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, text);
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

/** Refuses (E_SCHEMA_INVALID, nothing written) a record with an absolute path or no `$schema`. */
export async function writeRunRecord(
  cacheDir: string,
  record: Omit<RunRecord, '$schema'>,
): Promise<{ path: string; latestPath: string }> {
  const stamped = { $schema: runRecordSchema.$id, ...record };
  const safe = redactSecretsDeep(stamped, secretsFrom(process.env));
  const checked = validateJson<RunRecord>(safe, runRecordSchema);
  if (!checked.ok) {
    throw new VetError(
      CEV_ERROR_CODES.E_SCHEMA_INVALID,
      'run record is not portable: criteriaPath and casesPath must be relative to the config directory (a path on another drive cannot be), and `$schema` is required',
      { cause: checked.error },
    );
  }
  const dir = join(cacheDir, RUNS_DIR);
  const path = join(dir, `${checked.value.startedAt.replaceAll(/[:.]/g, '-')}.json`);
  const latestPath = join(dir, 'latest.json');
  const text = `${JSON.stringify(checked.value, null, 2)}\n`;
  await mkdir(dir, { recursive: true });
  await writeAtomic(path, text);
  await writeAtomic(latestPath, text);
  return { path, latestPath };
}

/** Missing record → null; an unreadable or malformed one throws. */
export async function readRunRecord(cacheDir: string): Promise<RunRecord | null> {
  let text: string;
  try {
    text = await readFile(join(cacheDir, RUNS_DIR, 'latest.json'), 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
  const parsed = safeParseJson<RunRecord>(text, runRecordSchema);
  if (!parsed.ok) {
    throw new VetError(
      CEV_ERROR_CODES.E_SCHEMA_INVALID,
      'the latest run record is missing or malformed, or was written by an older vetkit; run `vet run` to write a current record',
      { cause: parsed.error },
    );
  }
  return parsed.value;
}
