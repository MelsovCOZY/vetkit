// `vet check --lock|--outbox` (bead mol-p4a.2). The --lock cases moved here from validate.test.ts
// (q4q.6) when check left validate.ts; validate itself writes the lock each case starts from.
import { appendFile, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEvents, createOutbox, readLock, resolveConfig, type Events } from '@vetkit/core';
import {
  CEV_ERROR_CODES,
  safeParseJson,
  VetError,
  type Answer,
  type JudgeResponse,
  type JudgeV1,
  type Lock,
  type SinkV1,
  type Verdict,
} from '@vetkit/spec';
import { Command } from 'commander';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { handleError } from '../errors.ts';
import { configureOutput } from '../output.ts';
import { registerCheck } from './check.ts';
import { registerValidate, type ValidateDeps } from './validate.ts';

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
const HEADER = 'case_id,criterion_id,label,labeler,labeled_at';

// ---------- fixture project ----------

interface Row {
  readonly id: string;
  readonly p: number;
  readonly label: 'pass' | 'fail' | 'unknown';
}

// 100 passes at P 0.99, 99 fails at P 0.01, and one unknown-labelled case at P 0.5: the fitted
// threshold lands on the 0.50/0.51 tie median, so only BORDER sits in the tolerance band.
function standardRows(): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < 100; i += 1) rows.push({ id: `p${String(i)}`, p: 0.99, label: 'pass' });
  for (let i = 0; i < 99; i += 1) rows.push({ id: `f${String(i)}`, p: 0.01, label: 'fail' });
  rows.push({ id: 'border', p: 0.5, label: 'unknown' });
  return rows;
}

async function project(rows: readonly Row[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'vetkit-validate-'));
  await mkdir(join(root, 'evals', 'cases'), { recursive: true });
  await mkdir(join(root, 'evals', 'labels'), { recursive: true });
  await writeFile(join(root, 'evals', 'criteria.yaml'), CRITERIA_YAML);
  const lines = rows.map((r) =>
    JSON.stringify({ id: r.id, input: { state: `S-${r.id}` }, provenance: null, tags: [] }),
  );
  await writeFile(join(root, 'evals', 'cases', 'cases.jsonl'), `${lines.join('\n')}\n`);
  const labels = rows.map((r) => `${r.id},tone,${r.label},tester,2026-09-28T00:00:00Z`);
  await writeFile(join(root, 'evals', 'labels', 'tone.csv'), `${[HEADER, ...labels].join('\n')}\n`);
  return root;
}

function answer(p: number): Answer {
  return {
    type: 'choice',
    choice: p >= 0.5 ? 'yes' : 'no',
    confidence: Math.max(p, 1 - p),
    probabilities: { yes: p, no: 1 - p, escape: 0 },
  };
}

interface Counting {
  readonly judge: JudgeV1;
  /** doJudge calls per state while the validate phase is `calibration`. */
  readonly calibrationCalls: Map<string, number>;
  total: number;
}

function countingJudge(
  rows: readonly Row[],
  events: Events,
  opts: { pinned?: boolean; transport?: string; releaseDate?: string } = {},
): Counting {
  const pByState = new Map(rows.map((r) => [`S-${r.id}`, r.p]));
  let phase = 'none';
  // DiagData carries numbers and booleans only, so the phase rides in the code.
  const PREFIX = 'VALIDATE_PHASE_';
  events.on('diag', ({ code }) => {
    if (code.startsWith(PREFIX)) phase = code.slice(PREFIX.length).toLowerCase();
  });
  const pinned = opts.pinned ?? true;
  const transport = opts.transport ?? 'fake-transport';
  const counting: Counting = {
    calibrationCalls: new Map(),
    total: 0,
    judge: {
      specVersion: 'v1',
      id: 'counting',
      capabilities: {
        questionTypes: ['boolean', 'choice', 'score'],
        maxStateTokens: 32_000,
        pinned,
        transport,
        model: 'fake/jev',
      },
      doJudge: (req) => {
        counting.total += 1;
        if (phase === 'calibration') {
          counting.calibrationCalls.set(
            req.state,
            (counting.calibrationCalls.get(req.state) ?? 0) + 1,
          );
        }
        // Gauntlets rewrite the state; fall back to the source case's P by prefix.
        const key = [...pByState.keys()].find((s) => req.state.startsWith(s));
        const p = key === undefined ? 0 : (pByState.get(key) ?? 0);
        const answers: Record<string, Answer> = {};
        for (const k of Object.keys(req.questions)) answers[k] = answer(p);
        const model: JudgeResponse['model'] = {
          requested: 'fake/jev',
          resolved: 'fake/jev-1',
          transport,
          pinned,
          ...(opts.releaseDate === undefined ? {} : { releaseDate: opts.releaseDate }),
        };
        return Promise.resolve({ answers, usage: { inputTokens: 1, outputTokens: 0 }, model });
      },
    },
  };
  return counting;
}

function depsFor(root: string, judge: JudgeV1, events: Events): ValidateDeps {
  const { config } = resolveConfig({ judge });
  return {
    events,
    loadConfig: () => Promise.resolve({ config, judge, rootDir: root, warnings: [] }),
  };
}

let stdout: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  stdout = [];
});

async function vet(args: readonly string[], deps: ValidateDeps): Promise<unknown> {
  configureOutput({ json: true, quiet: true });
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  const program = new Command();
  program.exitOverride().option('--json');
  registerValidate(program, deps);
  registerCheck(program, deps);
  try {
    await program.parseAsync(['node', 'vet', '--json', ...args]);
  } finally {
    spy.mockRestore();
  }
  return undefined;
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

function parse(text: string): Record<string, unknown> {
  const r = safeParseJson<Record<string, unknown>>(text, {});
  if (!r.ok) throw r.error;
  return r.value;
}

function report(): Record<string, unknown> {
  const first = stdout
    .join('')
    .split('\n')
    .find((l) => l.trim() !== '');
  if (first === undefined) throw new Error('no stdout');
  return parse(first);
}

async function lockAt(root: string): Promise<Lock> {
  const r = await readLock(join(root, 'criteria.lock.json'));
  if ('error' in r) throw r.error;
  return r;
}

// ---------- vet check --lock ----------

describe('vet check --lock', () => {
  test('check --lock fresh → exit 0 {stale:false}', async () => {
    const rows = standardRows();
    const root = await project(rows);
    const events = createEvents();
    const { judge } = countingJudge(rows, events);
    const deps = depsFor(root, judge, events);
    await vet(['validate'], deps);
    stdout = [];
    await vet(['check', '--lock'], deps);

    expect(report()).toMatchObject({ stale: false, reasons: [] });
    expect(process.exitCode ?? 0).toBe(0);
  });

  test('check --lock stale → exit 1 {stale:true, reasons}', async () => {
    const rows = standardRows();
    const root = await project(rows);
    const events = createEvents();
    const { judge } = countingJudge(rows, events);
    const deps = depsFor(root, judge, events);
    await vet(['validate'], deps);
    const casesFile = join(root, 'evals', 'cases', 'cases.jsonl');
    await writeFile(casesFile, (await readFile(casesFile, 'utf8')).replace('S-p0', 'S-p0 edited'));
    stdout = [];
    await vet(['check', '--lock'], deps);

    expect(report()).toMatchObject({ stale: true, reasons: ['datasetHash'] });
    expect(process.exitCode).toBe(1);
  });

  test('check --lock compares releaseDate through describeModel and transport', async () => {
    const rows = standardRows();
    const root = await project(rows);
    const events = createEvents();
    const { judge } = countingJudge(rows, events, { releaseDate: '2026-09-15' });
    await vet(['validate'], depsFor(root, judge, events));
    expect((await lockAt(root)).model.releaseDate).toBe('2026-09-15');

    const newer = { ...judge, describeModel: () => Promise.resolve({ releaseDate: '2026-10-01' }) };
    stdout = [];
    await vet(['check', '--lock'], depsFor(root, newer, events));
    expect(report()).toMatchObject({ stale: true, reasons: ['releaseDate'] });

    const broken = { ...judge, describeModel: () => Promise.reject(new Error('no endpoint')) };
    stdout = [];
    process.exitCode = undefined;
    await vet(['check', '--lock'], depsFor(root, broken, events));
    expect(report()).toMatchObject({ stale: false, releaseDate: 'unknown' });

    const moved = { ...judge, capabilities: { ...judge.capabilities, transport: 'transport-b' } };
    stdout = [];
    await vet(['check', '--lock'], depsFor(root, moved, events));
    expect(report()).toMatchObject({ stale: true, reasons: ['transport'] });
  });

  test('check --lock missing → exit 2', async () => {
    const rows = standardRows();
    const root = await project(rows);
    const events = createEvents();
    const { judge } = countingJudge(rows, events);
    const error = await rejection(vet(['check', '--lock'], depsFor(root, judge, events)));

    expect(exitCodeOf(error)).toBe(2);
    expect(VetError.isInstance(error) && error.message).toContain('criteria.lock.json');
  });

  test('LOCK_STALE → exit 1 via handleError', () => {
    expect(exitCodeOf(new VetError(CEV_ERROR_CODES.LOCK_STALE, 'stale'))).toBe(1);
  });
});

// ---------- per-criterion drift (mol-p4a.2) ----------

interface Validated {
  readonly root: string;
  readonly events: Events;
  readonly judge: JudgeV1;
}

async function validated(): Promise<Validated> {
  const rows = standardRows();
  const root = await project(rows);
  const events = createEvents();
  const { judge } = countingJudge(rows, events);
  await vet(['validate'], depsFor(root, judge, events));
  stdout = [];
  return { root, events, judge };
}

describe('vet check --lock per criterion', () => {
  test('fresh lock lists no stale criteria', async () => {
    const { root, events, judge } = await validated();
    await vet(['check', '--lock'], depsFor(root, judge, events));

    expect(report()).toMatchObject({ stale: false, staleCriteria: [] });
    expect(process.exitCode ?? 0).toBe(0);
  });

  test('wording drift → exit 1 listing the criterion with wording_changed', async () => {
    const { root, events, judge } = await validated();
    const file = join(root, 'evals', 'criteria.yaml');
    const yaml = await readFile(file, 'utf8');
    await writeFile(file, yaml.replace('Is the reply polite?', 'Is the reply rude?'));
    await vet(['check', '--lock'], depsFor(root, judge, events));

    expect(report()).toMatchObject({
      stale: true,
      staleCriteria: [{ id: 'tone', reasons: ['wording_changed'] }],
    });
    expect(process.exitCode).toBe(1);
  });

  test('model drift (requested id differs from the config judge) → exit 1 with model_changed', async () => {
    const { root, events, judge } = await validated();
    const other = { ...judge, capabilities: { ...judge.capabilities, model: 'fake/jev-2' } };
    await vet(['check', '--lock'], depsFor(root, other, events));

    const r = report();
    expect(r).toMatchObject({
      stale: true,
      staleCriteria: [{ id: 'tone', reasons: ['model_changed'] }],
    });
    expect(r['reasons']).toContain('requested');
    expect(process.exitCode).toBe(1);
  });

  test('transport drift marks every criterion model_changed', async () => {
    const { root, events, judge } = await validated();
    const moved = { ...judge, capabilities: { ...judge.capabilities, transport: 'transport-b' } };
    await vet(['check', '--lock'], depsFor(root, moved, events));

    expect(report()).toMatchObject({
      staleCriteria: [{ id: 'tone', reasons: ['model_changed'] }],
    });
  });

  test('a criterion absent from the lock → exit 1 with uncalibrated', async () => {
    const { root, events, judge } = await validated();
    const file = join(root, 'evals', 'criteria.yaml');
    const extra = `  - id: brevity
    type: boolean
    instructions: Is the reply short?
    escape: The reply is empty.
    polarity: pass_when_true
    channel: quality
    provenance:
      traceIds: []
`;
    await writeFile(file, `${await readFile(file, 'utf8')}${extra}`);
    await vet(['check', '--lock'], depsFor(root, judge, events));

    expect(report()).toMatchObject({
      stale: true,
      staleCriteria: [{ id: 'brevity', reasons: ['uncalibrated'] }],
    });
    expect(process.exitCode).toBe(1);
  });

  test('a lock older than lockVersion 1 → exit 2 unsupported lockVersion', async () => {
    const { root, events, judge } = await validated();
    const path = join(root, 'criteria.lock.json');
    const lock = await lockAt(root);
    await writeFile(path, JSON.stringify({ ...lock, lockVersion: 0 }));
    const error = await rejection(vet(['check', '--lock'], depsFor(root, judge, events)));

    expect(exitCodeOf(error)).toBe(2);
    expect(VetError.isInstance(error) && error.message).toContain('unsupported lockVersion');
  });

  test('neither --lock nor --outbox → exit 2', async () => {
    const { root, events, judge } = await validated();
    const error = await rejection(vet(['check'], depsFor(root, judge, events)));

    expect(exitCodeOf(error)).toBe(2);
  });
});

// ---------- vet check --outbox ----------

function verdict(n: number): Verdict {
  return {
    id: `v${String(n)}`,
    caseId: `c${String(n)}`,
    criterionId: 'tone',
    status: 'ok',
    pass: true,
    model: { requested: 'm', resolved: 'm', transport: 't', pinned: false },
    cacheHit: false,
  };
}

// Three produced verdicts; v0 acked by sink s1, v1 dead-lettered by s1 when `dead` is set.
async function seedOutbox(dir: string, dead: boolean): Promise<void> {
  const outbox = createOutbox({ dir });
  await outbox.enqueue([verdict(0), verdict(1), verdict(2)]);
  const at = '2026-09-28T00:00:00Z';
  const acked = ['v0', ...(dead ? [] : ['v1', 'v2'])];
  await appendFile(
    join(dir, 'acked.jsonl'),
    acked.map((id) => `${JSON.stringify({ id, sink: 's1', at })}\n`).join(''),
  );
  if (dead) {
    await appendFile(
      join(dir, 'dead.jsonl'),
      `${JSON.stringify({ id: 'v1', sink: 's1', reason: 'rejected', at })}\n`,
    );
  }
}

  const sink = (id: string, skip: boolean): SinkV1 => ({
    specVersion: 'v1',
    id,
    capabilities: { batch: 10, idempotent: true },
    doWrite: (batch) =>
      Promise.resolve({
        accepted: skip ? [] : batch.map((v) => v.id ?? ''),
        rejected: skip
          ? batch.map((v) => ({
              id: v.id ?? '',
              reason: 'skipped:unscored:infra_failure',
              retryable: false,
            }))
          : [],
      }),
  });

describe('vet check --outbox', () => {
  test('outbox: --outbox --json prints {produced, acknowledged, dead} from <cacheDir>/outbox', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vetkit-check-outbox-'));
    const events = createEvents();
    const { judge } = countingJudge([], events);
    const { config } = resolveConfig({ judge });
    await mkdir(join(root, config.cacheDir), { recursive: true });
    await seedOutbox(join(root, config.cacheDir, 'outbox'), true);
    await vet(['check', '--outbox'], depsFor(root, judge, events));

    expect(report()).toEqual({ produced: 3, acknowledged: 1, dead: 1 });
    // A dead-lettered verdict never reached its sink.
    expect(process.exitCode).toBe(1);
  });

  test('outbox: a sink that skipped an unscored verdict reconciles as acknowledged, dead 0', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'vetkit-check-outbox-')), 'outbox');
    const outbox = createOutbox({ dir });
    await outbox.enqueue([verdict(0), verdict(1)], { targets: ['otel', 'langfuse'] });
    await outbox.drain([sink('otel', false), sink('langfuse', true)]);
    const events = createEvents();
    const { judge } = countingJudge([], events);
    await vet(['check', '--outbox', dir], depsFor(dir, judge, events));

    expect(report()).toEqual({ produced: 2, acknowledged: 2, dead: 0 });
    expect(process.exitCode ?? 0).toBe(0);
  });

  test('outbox: --outbox <dir> with every verdict acknowledged → exit 0', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'vetkit-check-outbox-')), 'outbox');
    await seedOutbox(dir, false);
    const events = createEvents();
    const { judge } = countingJudge([], events);
    await vet(['check', '--outbox', dir], depsFor(dir, judge, events));

    expect(report()).toEqual({ produced: 3, acknowledged: 3, dead: 0 });
    expect(process.exitCode ?? 0).toBe(0);
  });

  test('--lock --outbox prints both sections and exits with the larger code', async () => {
    const { root, events, judge } = await validated();
    const dir = join(root, 'seeded-outbox');
    await seedOutbox(dir, true);
    await vet(['check', '--lock', '--outbox', dir], depsFor(root, judge, events));

    expect(report()).toMatchObject({
      lock: { stale: false, reasons: [] },
      outbox: { produced: 3, acknowledged: 1, dead: 1 },
    });
    expect(process.exitCode).toBe(1);
  });
});
