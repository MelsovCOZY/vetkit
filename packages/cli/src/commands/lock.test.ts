// `vet lock refresh` (bead mol-p4a.2): re-hashes each criterion's wording with the J3
// normalisation (loadCriteria's wordingHash) and keeps the lock entry when the normalised
// wording is unchanged; a semantic change stays stale with a pointer to `vet validate`.
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEvents, loadCriteria, readLock, resolveConfig } from '@vetkit/core';
import { safeParseJson, VetError, type JudgeV1, type Lock } from '@vetkit/spec';
import { Command } from 'commander';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { handleError } from '../errors.ts';
import { configureOutput } from '../output.ts';
import type { ValidateDeps } from './validate.ts';
import { registerLock } from './lock.ts';

const CRITERIA_YAML = `criteria:
  - id: tone
    type: boolean
    instructions: Is the reply polite?
    escape: The reply has no discernible tone.
    polarity: pass_when_true
    channel: quality
    provenance:
      traceIds: []
`;

// Same wording after the J3 normalisation: comments, CRLF line ends and a block scalar whose
// trailing newline is trimmed.
const CRITERIA_YAML_REFORMATTED = [
  '# criteria for the support bot',
  'criteria:',
  '  - id: tone # the one criterion',
  '    type: boolean',
  '    instructions: |',
  '      Is the reply polite?',
  '    escape: The reply has no discernible tone.',
  '    polarity: pass_when_true',
  '    channel: quality',
  '    provenance:',
  '      traceIds: []',
  '',
].join('\r\n');

const judge: JudgeV1 = {
  specVersion: 'v1',
  id: 'fake',
  capabilities: {
    questionTypes: ['boolean', 'choice', 'score'],
    maxStateTokens: 32_000,
    pinned: true,
    transport: 'fake-transport',
    model: 'fake/jev',
  },
  doJudge: () => Promise.reject(new Error('lock refresh never judges')),
};

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'vetkit-lock-'));
  await mkdir(join(root, 'evals'), { recursive: true });
  const file = join(root, 'evals', 'criteria.yaml');
  await writeFile(file, CRITERIA_YAML);
  const loaded = await loadCriteria(file);
  if (!loaded.ok) throw new Error('fixture criteria invalid');
  const hash = loaded.criteria[0]?.wordingHash ?? '';
  const lock: Lock = {
    lockVersion: 1,
    model: {
      requested: 'fake/jev',
      resolved: 'fake/jev-1',
      transport: 'fake-transport',
      pinned: true,
    },
    criteria: {
      tone: {
        wordingHash: hash,
        status: 'calibrated',
        threshold: 0.42,
        tolerance: 0.03,
        gauntlet: {
          paraphrase: 'pass',
          polarity: 'pass',
          injection: 'pass',
          master_key: 'pass',
          label_permutation: 'pass',
          constant_output: 'pass',
          position_swap: 'pass',
          length: 'pass',
        },
        reasons: [],
        labelCount: 120,
      },
    },
    datasetHash: 'b'.repeat(64),
  };
  await writeFile(join(root, 'criteria.lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
  return root;
}

function depsFor(root: string): ValidateDeps {
  const { config } = resolveConfig({ judge });
  return {
    events: createEvents(),
    loadConfig: () => Promise.resolve({ config, judge, rootDir: root, warnings: [] }),
  };
}

let stdout: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  stdout = [];
});

async function vet(args: readonly string[], deps: ValidateDeps): Promise<void> {
  configureOutput({ json: true, quiet: true });
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  const program = new Command();
  program.exitOverride().option('--json');
  registerLock(program, deps);
  try {
    await program.parseAsync(['node', 'vet', '--json', ...args]);
  } finally {
    spy.mockRestore();
  }
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the command to reject');
}

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

function report(): Record<string, unknown> {
  const first = stdout
    .join('')
    .split('\n')
    .find((l) => l.trim() !== '');
  if (first === undefined) throw new Error('no stdout');
  const r = safeParseJson<Record<string, unknown>>(first, {});
  if (!r.ok) throw r.error;
  return r.value;
}

async function lockAt(root: string): Promise<Lock> {
  const r = await readLock(join(root, 'criteria.lock.json'));
  if ('error' in r) throw r.error;
  return r;
}

describe('vet lock refresh', () => {
  test('whitespace/comment-only edit → entry refreshed, threshold kept, exit 0', async () => {
    const root = await project();
    await writeFile(join(root, 'evals', 'criteria.yaml'), CRITERIA_YAML_REFORMATTED);
    await vet(['lock', 'refresh'], depsFor(root));

    expect(report()).toMatchObject({ refreshed: ['tone'], stale: [] });
    expect(process.exitCode ?? 0).toBe(0);
    const loaded = await loadCriteria(join(root, 'evals', 'criteria.yaml'));
    if (!loaded.ok) throw new Error('reformatted criteria invalid');
    const entry = (await lockAt(root)).criteria['tone'];
    expect(entry?.wordingHash).toBe(loaded.criteria[0]?.wordingHash);
    expect(entry).toMatchObject({ status: 'calibrated', threshold: 0.42, tolerance: 0.03 });
  });

  test('semantic change → left stale with a vet validate message, lock untouched, exit 1', async () => {
    const root = await project();
    const lockPath = join(root, 'criteria.lock.json');
    const before = await readFile(lockPath, 'utf8');
    await writeFile(
      join(root, 'evals', 'criteria.yaml'),
      CRITERIA_YAML.replace('Is the reply polite?', 'Is the reply rude?'),
    );
    await vet(['lock', 'refresh'], depsFor(root));

    const r = report();
    expect(r).toMatchObject({ refreshed: [], stale: [{ id: 'tone' }] });
    expect(JSON.stringify(r['stale'])).toContain('vet validate');
    expect(process.exitCode).toBe(1);
    expect(await readFile(lockPath, 'utf8')).toBe(before);
  });

  test('--lock <path> refreshes that lock', async () => {
    const root = await project();
    const moved = join(root, 'other.lock.json');
    await writeFile(moved, await readFile(join(root, 'criteria.lock.json'), 'utf8'));
    await vet(['lock', 'refresh', '--lock', moved], depsFor(root));

    expect(report()).toMatchObject({ refreshed: ['tone'], stale: [], lockPath: moved });
  });

  test('missing lock → exit 2', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vetkit-lock-'));
    await mkdir(join(root, 'evals'), { recursive: true });
    await writeFile(join(root, 'evals', 'criteria.yaml'), CRITERIA_YAML);
    const error = await rejection(vet(['lock', 'refresh'], depsFor(root)));

    expect(exitCodeOf(error)).toBe(2);
    expect(VetError.isInstance(error) && error.message).toContain('criteria.lock.json');
  });

  test('a lock older than lockVersion 1 → exit 2 unsupported lockVersion', async () => {
    const root = await project();
    const lock = await lockAt(root);
    await writeFile(join(root, 'criteria.lock.json'), JSON.stringify({ ...lock, lockVersion: 0 }));
    const error = await rejection(vet(['lock', 'refresh'], depsFor(root)));

    expect(exitCodeOf(error)).toBe(2);
    expect(VetError.isInstance(error) && error.message).toContain('unsupported lockVersion');
  });
});
