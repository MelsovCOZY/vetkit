// The persisted result of the last `vet run`: the runEvals result as `vet run --json`
// prints it, plus where its criteria and cases came from and when it started. It lives at
// <cacheDir>/runs/latest.json, the path the GitHub Action also fills from --json output,
// and is written through a temp file and rename so a reader never sees half a record.
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { safeParseJson } from '@vetkit/spec';
import type { RunEvalsResult } from './run.ts';

export interface RunRecord extends RunEvalsResult {
  criteriaPath: string;
  casesPath: string;
  /** ISO 8601 time the run started. */
  startedAt: string;
}

const runRecordSchema = {
  type: 'object',
  required: ['results', 'summary', 'model'],
  properties: {
    results: { type: 'array' },
    summary: { type: 'object' },
    model: { type: 'object' },
  },
};

function recordPath(cacheDir: string): string {
  return join(cacheDir, 'runs', 'latest.json');
}

export async function writeRunRecord(cacheDir: string, record: RunRecord): Promise<void> {
  const path = recordPath(cacheDir);
  await mkdir(join(cacheDir, 'runs'), { recursive: true });
  const tmp = `${path}.${String(process.pid)}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`);
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

/** Missing record → null; an unreadable or malformed one throws. */
export async function readRunRecord(cacheDir: string): Promise<RunRecord | null> {
  let text: string;
  try {
    text = await readFile(recordPath(cacheDir), 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
  const parsed = safeParseJson<RunRecord>(text, runRecordSchema);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}
