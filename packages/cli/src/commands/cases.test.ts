// `vet cases dedupe|quarantine|promote|review`.
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCases, writeRunRecord, type RunRecord } from '@vetkit/core';
import { safeParseJson, VetError, type Case, type ParseResult } from '@vetkit/spec';
import { Command } from 'commander';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { handleError } from '../errors.ts';
import { configureOutput } from '../output.ts';
import { registerCases, type CasesDeps } from './cases.ts';

interface Project {
  readonly root: string;
  readonly cases: string;
  readonly cacheDir: string;
}

async function project(): Promise<Project> {
  const root = await mkdtemp(join(tmpdir(), 'vetkit-cases-'));
  const cases = join(root, 'evals', 'cases');
  await mkdir(cases, { recursive: true });
  return { root, cases, cacheDir: join(root, '.vet') };
}

function mkCase(id: string, state: string, overrides: Partial<Case> = {}): Case {
  return { id, input: { state }, provenance: null, tags: [], ...overrides };
}

function caseLine(c: Case): string {
  return JSON.stringify(c);
}

function unwrap<T>(parsed: ParseResult<T>): T {
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

async function readCases(file: string): Promise<Case[]> {
  const text = await readFile(file, 'utf8');
  return text
    .split('\n')
    .filter((l) => l !== '')
    .map((raw) => unwrap(safeParseJson<Case>(raw, {})));
}

function baseRecord(p: Project, overrides: Partial<RunRecord> = {}): RunRecord {
  const model = { requested: 'm', resolved: 'm-resolved', transport: 'fake', pinned: false };
  return {
    results: [],
    summary: { total: 0, passed: 0, failed: 0, unscored: 0, aborted: false, byCriterion: {} },
    model,
    exitCode: 0,
    gateReasons: [],
    criteriaPath: join(p.root, 'evals', 'criteria.yaml'),
    casesPath: p.cases,
    startedAt: '2026-09-29T00:00:00.000Z',
    ...overrides,
  };
}

let stdout: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  stdout = [];
});

async function vet(
  args: readonly string[],
  options: { json?: boolean; deps?: CasesDeps } = {},
): Promise<string> {
  configureOutput({ json: options.json ?? true, quiet: true });
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  const program = new Command();
  program.exitOverride().option('--json');
  registerCases(program, options.deps ?? {});
  try {
    await program.parseAsync(['node', 'vet', 'cases', ...args]);
  } finally {
    spy.mockRestore();
  }
  return stdout.join('');
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the command to reject');
}

// The CLI-wide exit mapping: what `vet` would exit with for this error.
function exitCodeOf(error: unknown): number {
  const sink = { write: () => true };
  let code = -1;
  try {
    handleError(error, {
      json: false,
      verbose: false,
      strict: false,
      stdout: sink,
      stderr: sink,
      exit: (c: number) => {
        code = c;
        throw new Error('exit');
      },
    });
  } catch {
    // unwound by the exit double above
  }
  return code;
}

describe('vet cases dedupe', () => {
  test('report only: exact duplicates are reported, the file is unchanged without --write', async () => {
    const p = await project();
    await writeFile(
      join(p.cases, 'a.jsonl'),
      `${caseLine(mkCase('case-2', 'same state'))}\n${caseLine(mkCase('case-1', ' same state '))}\n`,
    );

    const doc = unwrap(
      safeParseJson<{ duplicates: unknown; written: boolean }>(
        await vet(['dedupe', '--cases', p.cases]),
        {},
      ),
    );

    expect(doc.duplicates).toEqual([{ kept: 'case-1', removed: 'case-2' }]);
    expect(doc.written).toBe(false);
    expect(await readCases(join(p.cases, 'a.jsonl'))).toHaveLength(2);
  });

  test('--write removes duplicates, keeping the earliest by id', async () => {
    const p = await project();
    await writeFile(
      join(p.cases, 'a.jsonl'),
      `${caseLine(mkCase('case-2', 'same state'))}\n${caseLine(mkCase('case-1', ' same state '))}\n`,
    );

    const doc = unwrap(
      safeParseJson<{ written: boolean }>(await vet(['dedupe', '--write', '--cases', p.cases]), {}),
    );

    expect(doc.written).toBe(true);
    const remaining = await readCases(join(p.cases, 'a.jsonl'));
    expect(remaining.map((c) => c.id)).toEqual(['case-1']);
  });

  test('no duplicates: pretty output is "none"', async () => {
    const p = await project();
    await writeFile(join(p.cases, 'a.jsonl'), `${caseLine(mkCase('case-1', 'one'))}\n`);

    const text = await vet(['dedupe', '--cases', p.cases], { json: false });

    expect(text.split('\n')[0]).toBe('none');
  });

  test('0 cases: pretty output is "none"', async () => {
    const p = await project();

    const text = await vet(['dedupe', '--cases', p.cases], { json: false });

    expect(text.split('\n')[0]).toBe('none');
  });

  test('near-duplicate report: two paraphrased cases → one cluster; --write never touches them', async () => {
    const p = await project();
    const stateA =
      'The user asked how to reset their password after three failed login attempts and wanted to know whether the account would be locked for security reasons following those attempts.';
    const stateB =
      'The user asked how to reset their password after three failed login attempts and wanted to know whether the account would be suspended for security reasons following those attempts.';
    await writeFile(
      join(p.cases, 'a.jsonl'),
      `${caseLine(mkCase('nd-1', stateA))}\n${caseLine(mkCase('nd-2', stateB))}\n`,
    );

    const doc = unwrap(
      safeParseJson<{
        duplicates: unknown[];
        nearDuplicates: readonly { clusterId: string; caseIds: string[] }[];
      }>(await vet(['dedupe', '--write', '--cases', p.cases]), {}),
    );

    expect(doc.duplicates).toEqual([]);
    expect(doc.nearDuplicates).toHaveLength(1);
    expect([...(doc.nearDuplicates[0]?.caseIds ?? [])].toSorted()).toEqual(['nd-1', 'nd-2']);
    // --write only removes exact-hash duplicates; both near-duplicates survive.
    expect(await readCases(join(p.cases, 'a.jsonl'))).toHaveLength(2);
  });
});

describe('vet cases quarantine', () => {
  test('moves the case into quarantine.jsonl with reason+at; vet run then skips it', async () => {
    const p = await project();
    await writeFile(
      join(p.cases, 'a.jsonl'),
      `${caseLine(mkCase('keep', 's1'))}\n${caseLine(mkCase('bad', 's2'))}\n`,
    );

    const doc = unwrap(
      safeParseJson<{ status: string }>(
        await vet(['quarantine', 'bad', '--reason', 'garbage output', '--cases', p.cases]),
        {},
      ),
    );

    expect(doc.status).toBe('quarantined');
    const quarantined = await readCases(join(p.cases, 'quarantine.jsonl'));
    expect(quarantined[0]).toMatchObject({ id: 'bad', quarantine: { reason: 'garbage output' } });

    const loaded = await loadCases(p.cases);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.cases.map((c) => c.id)).toEqual(['keep']);
  });
});

describe('vet cases promote', () => {
  test('promotes the caseId:criterionId verdict from the latest run, asserting provenance.promotedFrom.verdictId', async () => {
    const p = await project();
    await writeFile(
      join(p.cases, 'a.jsonl'),
      `${caseLine(mkCase('case-1', 'hi', { traceId: 'trace-1' }))}\n`,
    );
    await writeRunRecord(
      p.cacheDir,
      baseRecord(p, {
        results: [
          {
            caseId: 'case-1',
            criterionId: 'k-1',
            status: 'ok',
            pass: false,
            model: { requested: 'm', resolved: 'm-resolved', transport: 'fake', pinned: false },
            cacheHit: false,
          },
        ],
      }),
    );

    const doc = unwrap(
      safeParseJson<{ promoted: Record<string, unknown> }>(
        await vet(['promote', 'case-1:k-1', '--cases', p.cases, '--cache-dir', p.cacheDir]),
        {},
      ),
    );

    expect(doc.promoted).toMatchObject({
      id: 'promoted-trace-1-k-1',
      provenance: {
        promotedFrom: { verdictId: 'case-1:k-1', criterionId: 'k-1', traceId: 'trace-1' },
      },
    });
    const dateStamp = new Date().toISOString().slice(0, 10);
    const written = await readCases(join(p.cases, `promoted-${dateStamp}.jsonl`));
    expect(written).toHaveLength(1);
  });

  test('a verdict id not in the latest run exits 2, naming the run record file', async () => {
    const p = await project();
    await writeRunRecord(p.cacheDir, baseRecord(p));

    const error = await rejection(
      vet(['promote', 'nope:crit', '--cases', p.cases, '--cache-dir', p.cacheDir]),
    );

    expect(exitCodeOf(error)).toBe(2);
    expect(VetError.isInstance(error) && error.message).toContain(
      join(p.cacheDir, 'runs', 'latest.json'),
    );
  });
});

async function pending(p: Project, cases: Case[]): Promise<void> {
  await mkdir(join(p.cases, 'pending'), { recursive: true });
  await writeFile(
    join(p.cases, 'pending', 'promoted-2026-09-28.jsonl'),
    cases.map((c) => `${caseLine(c)}\n`).join(''),
  );
}

describe('vet cases review', () => {
  test('review <id> accepts it into promoted-<date>.jsonl and out of pending', async () => {
    const p = await project();
    await pending(p, [mkCase('p-1', 's1')]);

    const doc = unwrap(
      safeParseJson<{ remaining: number }>(await vet(['review', 'p-1', '--cases', p.cases]), {}),
    );

    expect(doc.remaining).toBe(0);
    const dateStamp = new Date().toISOString().slice(0, 10);
    expect(await readCases(join(p.cases, `promoted-${dateStamp}.jsonl`))).toHaveLength(1);
  });

  test('review <id> --reject --reason moves it into quarantine.jsonl with the reason', async () => {
    const p = await project();
    await pending(p, [mkCase('p-2', 's2')]);

    const doc = unwrap(
      safeParseJson<{ remaining: number }>(
        await vet(['review', 'p-2', '--reject', '--reason', 'bad trace', '--cases', p.cases]),
        {},
      ),
    );

    expect(doc.remaining).toBe(0);
    const quarantined = await readCases(join(p.cases, 'quarantine.jsonl'));
    expect(quarantined[0]).toMatchObject({ id: 'p-2', quarantine: { reason: 'bad trace' } });
  });

  test('non-tty without <id>/--all exits 2 (NOT_INTERACTIVE)', async () => {
    const p = await project();
    await pending(p, [mkCase('p-3', 's3')]);

    const error = await rejection(
      vet(['review', '--cases', p.cases], { deps: { stdin: { isTTY: false } } }),
    );

    expect(exitCodeOf(error)).toBe(2);
  });
});
