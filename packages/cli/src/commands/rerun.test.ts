// `vet rerun --disputed` (mol-p4a.3): re-judges only verdicts from the last run that are
// disputed (borderline, or a judge failure), bypassing the cache for those cases, and writes a
// new latest run plus a --json run-to-run comparison.
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clusteredSE,
  loadCriteria,
  readRunRecord,
  resolveConfig,
  writeRunRecord,
  type RunRecord,
  type RunVerdict,
} from '@vetkit/core';
import { safeParseJson, VetError, type JudgeV1, type Lock } from '@vetkit/spec';
import { Command } from 'commander';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { handleError } from '../errors.ts';
import { configureOutput } from '../output.ts';
import type { ValidateDeps } from './validate.ts';
import { registerRerun } from './rerun.ts';

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

function fakeModel(): { requested: string; resolved: string; transport: string; pinned: boolean } {
  return {
    requested: 'fake/jev',
    resolved: 'fake/jev-1',
    transport: 'fake-transport',
    pinned: true,
  };
}

/** A judge whose answer for `caseId` comes from `passByCaseId`; records every case it is asked. */
function makeJudge(passByCaseId: ReadonlyMap<string, boolean>, seen: Set<string>): JudgeV1 {
  return {
    specVersion: 'v1',
    id: 'fake',
    capabilities: {
      questionTypes: ['boolean', 'choice', 'score'],
      maxStateTokens: 32_000,
      pinned: true,
      transport: 'fake-transport',
      model: 'fake/jev',
    },
    doJudge: (req) => {
      seen.add(req.state);
      const pass = passByCaseId.get(req.state) ?? false;
      return Promise.resolve({
        answers: Object.fromEntries(
          Object.keys(req.questions).map((id) => [
            id,
            { type: 'boolean' as const, probability: pass ? 0.9 : 0.1 },
          ]),
        ),
        usage: { inputTokens: 1, outputTokens: 1 },
        model: fakeModel(),
      });
    },
  };
}

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'vetkit-rerun-'));
  await mkdir(join(root, 'evals', 'cases'), { recursive: true });
  await writeFile(join(root, 'evals', 'criteria.yaml'), CRITERIA_YAML);
  return root;
}

// state doubles as the case id, so the fake judge (and `seen`) can key off it directly.
function writeCases(root: string, cases: { id: string; cluster?: string }[]): Promise<void> {
  const lines = cases.map((c) =>
    JSON.stringify({
      id: c.id,
      input: { state: c.id },
      provenance: null,
      tags: [],
      ...(c.cluster === undefined ? {} : { cluster: c.cluster }),
    }),
  );
  return writeFile(join(root, 'evals', 'cases', 'cases.jsonl'), `${lines.join('\n')}\n`);
}

function verdict(caseId: string, over: Partial<RunVerdict> = {}): RunVerdict {
  return {
    caseId,
    criterionId: 'tone',
    status: 'ok',
    answer: { type: 'boolean', probability: 0.9 },
    pass: true,
    threshold: 0.5,
    model: fakeModel(),
    cacheHit: false,
    ...over,
  };
}

/** A verdict with no answer/pass (unscored, error, infra_failure, …): `RunVerdict` under
 * exactOptionalPropertyTypes can't hold `answer: undefined`, so these keys are left out. */
function unjudgedVerdict(
  caseId: string,
  status: RunVerdict['status'],
  over: Partial<RunVerdict> = {},
): RunVerdict {
  return { caseId, criterionId: 'tone', status, model: fakeModel(), cacheHit: false, ...over };
}

async function seedRecord(root: string, results: RunVerdict[]): Promise<void> {
  const record: RunRecord = {
    results,
    summary: { total: 0, passed: 0, failed: 0, unscored: 0, aborted: false, byCriterion: {} },
    model: fakeModel(),
    exitCode: 0,
    gateReasons: [],
    criteriaPath: join(root, 'evals', 'criteria.yaml'),
    casesPath: join(root, 'evals', 'cases'),
    startedAt: new Date(0).toISOString(),
  };
  await writeRunRecord(join(root, '.vet'), record);
}

async function writeLock(root: string): Promise<void> {
  const loaded = await loadCriteria(join(root, 'evals', 'criteria.yaml'));
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
        threshold: 0.5,
        tolerance: 0.05,
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
        labelCount: 100,
      },
    },
    datasetHash: 'b'.repeat(64),
  };
  await writeFile(join(root, 'criteria.lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
}

function depsFor(root: string, judge: JudgeV1): ValidateDeps {
  const { config } = resolveConfig({ judge });
  return {
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
  registerRerun(program, deps);
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

describe('vet rerun --disputed', () => {
  test('no run record → exit 2 with RUN_NOT_FOUND', async () => {
    const root = await project();
    const seen = new Set<string>();
    const error = await rejection(
      vet(['rerun', '--disputed'], depsFor(root, makeJudge(new Map(), seen))),
    );

    expect(exitCodeOf(error)).toBe(2);
    expect(VetError.isInstance(error) && error.code).toBe('RUN_NOT_FOUND');
    expect(seen.size).toBe(0);
  });

  test('empty disputed set → exit 0, prints "nothing to rerun", never calls the judge', async () => {
    const root = await project();
    await writeCases(root, [{ id: 'case-1' }]);
    await seedRecord(root, [verdict('case-1', { borderline: false })]);
    const seen = new Set<string>();

    await vet(['rerun', '--disputed'], depsFor(root, makeJudge(new Map(), seen)));

    expect(process.exitCode ?? 0).toBe(0);
    expect(report()).toMatchObject({ disputed: 0 });
    expect(seen.size).toBe(0);
    const record = await readRunRecord(join(root, '.vet'));
    expect(record?.results).toEqual([verdict('case-1', { borderline: false })]);
  });

  test('re-judges exactly the disputed ids (borderline, unscored, error, infra_failure) and leaves others untouched', async () => {
    const root = await project();
    await writeCases(root, [
      { id: 'case-borderline' },
      { id: 'case-unscored' },
      { id: 'case-error' },
      { id: 'case-infra' },
      { id: 'case-fine' },
    ]);
    await seedRecord(root, [
      verdict('case-borderline', { borderline: true, pass: false }),
      unjudgedVerdict('case-unscored', 'unscored'),
      unjudgedVerdict('case-error', 'error'),
      unjudgedVerdict('case-infra', 'infra_failure'),
      verdict('case-fine', { borderline: false, pass: true }),
    ]);
    await writeLock(root);
    const seen = new Set<string>();
    const passByCaseId = new Map([
      ['case-borderline', true],
      ['case-unscored', true],
      ['case-error', true],
      ['case-infra', true],
    ]);

    await vet(['rerun', '--disputed'], depsFor(root, makeJudge(passByCaseId, seen)));

    expect([...seen].toSorted()).toEqual(
      ['case-borderline', 'case-error', 'case-infra', 'case-unscored'].toSorted(),
    );
    expect(process.exitCode ?? 0).toBe(0);
    const record = await readRunRecord(join(root, '.vet'));
    const byId = new Map(record?.results.map((v) => [v.caseId, v]));
    expect(byId.get('case-borderline')).toMatchObject({ status: 'ok', pass: true });
    expect(byId.get('case-unscored')).toMatchObject({ status: 'ok', pass: true });
    // untouched: never sent to the judge, verdict unchanged
    expect(byId.get('case-fine')).toEqual(verdict('case-fine', { borderline: false, pass: true }));
  });

  test('a judge failure on rerun keeps the previous verdict, remarked infra_failure', async () => {
    const root = await project();
    await writeCases(root, [{ id: 'case-1' }]);
    await seedRecord(root, [verdict('case-1', { borderline: true, pass: false })]);
    await writeLock(root);
    const failingJudge: JudgeV1 = {
      specVersion: 'v1',
      id: 'fake',
      capabilities: {
        questionTypes: ['boolean'],
        maxStateTokens: 32_000,
        pinned: true,
        transport: 'fake-transport',
        model: 'fake/jev',
      },
      doJudge: () => Promise.reject(new Error('judge unavailable')),
    };

    await vet(['rerun', '--disputed'], depsFor(root, failingJudge));

    const record = await readRunRecord(join(root, '.vet'));
    expect(record?.results).toMatchObject([
      { caseId: 'case-1', status: 'infra_failure', pass: false },
    ]);
  });

  test('no lock → falls back to confidence < 0.5 as disputed', async () => {
    const root = await project();
    await writeCases(root, [{ id: 'case-unsure' }, { id: 'case-sure' }]);
    await seedRecord(root, [
      verdict('case-unsure', {
        answer: { type: 'score', score: 1, confidence: 0.3, legend: {}, probabilities: {} },
      }),
      verdict('case-sure', {
        answer: { type: 'score', score: 1, confidence: 0.9, legend: {}, probabilities: {} },
      }),
    ]);
    const seen = new Set<string>();
    const passByCaseId = new Map([['case-unsure', true]]);

    await vet(['rerun', '--disputed'], depsFor(root, makeJudge(passByCaseId, seen)));

    expect([...seen]).toEqual(['case-unsure']);
  });

  test('comparison: paired per-case pass differences, clustered SE ≥ naive SE (4 cases, 2 clusters)', async () => {
    const root = await project();
    // Distinctive (not near-duplicate) states: clusters here come only from the `cluster` field,
    // never from clusterKeys' text-similarity path.
    const ids = ['aardvark', 'bumblebee', 'cactus-flower', 'dolphin-song'];
    await writeCases(root, [
      { id: ids[0] ?? '', cluster: 'A' },
      { id: ids[1] ?? '', cluster: 'A' },
      { id: ids[2] ?? '', cluster: 'B' },
      { id: ids[3] ?? '', cluster: 'B' },
    ]);
    // Previous: cluster A passed, cluster B failed. All borderline (fully disputed).
    await seedRecord(root, [
      verdict(ids[0] ?? '', { borderline: true, pass: true }),
      verdict(ids[1] ?? '', { borderline: true, pass: true }),
      verdict(ids[2] ?? '', { borderline: true, pass: false }),
      verdict(ids[3] ?? '', { borderline: true, pass: false }),
    ]);
    await writeLock(root);
    const seen = new Set<string>();
    // New: cluster A now fails, cluster B now passes (a correlated within-cluster flip).
    const passByCaseId = new Map([
      [ids[0] ?? '', false],
      [ids[1] ?? '', false],
      [ids[2] ?? '', true],
      [ids[3] ?? '', true],
    ]);

    await vet(['rerun', '--disputed'], depsFor(root, makeJudge(passByCaseId, seen)));

    const doc = report();
    // doc is the --json document, parsed as unknown JSON; shape asserted by the reads below.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const comparison = (doc['comparison'] as Record<string, { meanDiff: number; se: number }>)[
      'tone'
    ];
    if (comparison === undefined) throw new Error('no comparison for criterion tone');
    expect(comparison.meanDiff).toBe(0);
    const naive = clusteredSE([-1, -1, 1, 1], ids);
    expect(naive.se).not.toBeNull();
    expect(comparison.se).not.toBeNull();
    expect(comparison.se).toBeGreaterThanOrEqual(naive.se ?? 0);
  });
});
