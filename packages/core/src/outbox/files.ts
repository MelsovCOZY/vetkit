// Append-only JSONL helpers and the single-writer `.lock` for the outbox directory.
// Every line is read back through spec's safeParseJson; a bad line is OUTBOX_CORRUPT.
import { appendFile, mkdir, open, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { CEV_ERROR_CODES, safeParseJson, VetError, type JsonSchema } from '@vetkit/spec';

function isErrnoCode(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === code;
}

export async function appendLines(file: string, records: readonly unknown[]): Promise<void> {
  if (records.length === 0) return;
  await appendFile(file, records.map((r) => `${JSON.stringify(r)}\n`).join(''), 'utf8');
}

// Parses each non-empty line against `schema`, then runs `check` (for nested validation).
// A missing file is empty. Errors name `<file>:<line>` (1-based).
export async function scanLines<T>(
  file: string,
  schema: JsonSchema,
  check?: (value: T) => VetError | undefined,
): Promise<T[]> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if (isErrnoCode(err, 'ENOENT')) return [];
    throw new VetError(CEV_ERROR_CODES.E_IO, `Cannot read ${file}`, { cause: err });
  }
  const out: T[] = [];
  const rows = text.split('\n');
  for (const [i, line] of rows.entries()) {
    if (line === '' && i === rows.length - 1) break;
    const parsed = safeParseJson<T>(line, schema);
    const error = parsed.ok ? check?.(parsed.value) : parsed.error;
    if (error !== undefined) {
      throw new VetError(CEV_ERROR_CODES.OUTBOX_CORRUPT, `${file}:${i + 1}: ${error.message}`, {
        cause: error,
      });
    }
    if (parsed.ok) out.push(parsed.value);
  }
  return out;
}

function pidIsDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return isErrnoCode(err, 'ESRCH');
  }
}

async function acquire(lock: string, takeoverAllowed: boolean): Promise<void> {
  try {
    const handle = await open(lock, 'wx');
    try {
      await handle.writeFile(String(process.pid), 'utf8');
    } finally {
      await handle.close();
    }
    return;
  } catch (err) {
    if (!isErrnoCode(err, 'EEXIST')) {
      throw new VetError(CEV_ERROR_CODES.E_IO, `Cannot create ${lock}`, { cause: err });
    }
  }
  const text = await readFile(lock, 'utf8').catch(() => '');
  const pid = Number.parseInt(text.trim(), 10);
  if (takeoverAllowed && Number.isInteger(pid) && pid > 0 && pidIsDead(pid)) {
    await rm(lock, { force: true });
    await acquire(lock, false);
    return;
  }
  throw new VetError(CEV_ERROR_CODES.E_IO, `outbox locked by pid ${text.trim()}: ${lock}`, {
    details: {
      hint: 'another vet process is using this outbox; wait for it, or delete the lock if that process is gone.',
    },
  });
}

// Single writer per outbox dir: `<dir>/.lock` is created with O_EXCL and holds our pid.
// A lock whose pid no longer exists (ESRCH) is taken over, so a killed drain can resume.
export async function withLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(dir, { recursive: true });
  const lock = join(dir, '.lock');
  await acquire(lock, true);
  try {
    return await fn();
  } finally {
    await rm(lock, { force: true });
  }
}
