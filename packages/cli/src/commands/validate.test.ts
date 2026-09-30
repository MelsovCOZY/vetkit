import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertLockGates,
  computeWordingHash,
  createEvents,
  readLock,
  resolveConfig,
  type Events,
  type GeneratorAdapter,
} from '@vetkit/core';
import {
  CEV_ERROR_CODES,
  safeParseJson,
  VetError,
  type Answer,
  type JudgeResponse,
  type JudgeV1,
  type Lock,
  type LockCriterion,
} from '@vetkit/spec';
import { Command } from 'commander';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { handleError } from '../errors.ts';
import { configureOutput } from '../output.ts';
import { ensureCliBuilt } from '../test-support/build-cli.js';
import { registerValidate, type ValidateDeps } from './validate.ts';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const binPath = fileURLToPath(new URL('../../dist/bin.js', import.meta.url));
const runFixture = join(repoRoot, 'fixtures/cli/run');

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
  opts: {
    pinned?: boolean;
    transport?: string;
    releaseDate?: string;
    requestFormat?: 'raw' | 'fenced-v1';
  } = {},
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
        // Fake judge reads the raw state; default switched to fenced-v1 after the request-format A/B.
        requestFormat: opts.requestFormat ?? 'raw',
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

function depsFor(
  root: string,
  judge: JudgeV1,
  events: Events,
  generator?: GeneratorAdapter,
): ValidateDeps {
  const { config } = resolveConfig(generator === undefined ? { judge } : { judge, generator });
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

describe('vet validate', () => {
  test('writes requestFormat into the lock when the judge capability is fenced-v1', async () => {
    const rows = standardRows();
    const root = await project(rows);
    const events = createEvents();
    const { judge } = countingJudge(rows, events, { requestFormat: 'fenced-v1' });
    await vet(['validate'], depsFor(root, judge, events));
    expect((await lockAt(root)).requestFormat).toBe('fenced-v1');
  });

  test('records fenced-v1 in the lock when the judge leaves the format unset', async () => {
    const rows = standardRows();
    const root = await project(rows);
    const events = createEvents();
    const { judge: raw } = countingJudge(rows, events);
    const { requestFormat: _raw, ...capabilities } = raw.capabilities;
    await vet(['validate'], depsFor(root, { ...raw, capabilities }, events));
    expect((await lockAt(root)).requestFormat).toBe('fenced-v1');
  });

  test('omits requestFormat from the lock for a raw judge', async () => {
    const rows = standardRows();
    const root = await project(rows);
    const events = createEvents();
    const { judge } = countingJudge(rows, events, { requestFormat: 'raw' });
    await vet(['validate'], depsFor(root, judge, events));
    expect((await lockAt(root)).requestFormat).toBeUndefined();
  });

  test('validate --json writes criteria.lock.json and stdout parses (model, datasetHash)', async () => {
    const rows = standardRows();
    const root = await project(rows);
    const events = createEvents();
    const { judge } = countingJudge(rows, events);
    await vet(['validate'], depsFor(root, judge, events));

    const lock = await lockAt(root);
    expect(lock.lockVersion).toBe(1);
    expect(lock.criteria['tone']?.labelCount).toBe(200);
    const doc = report();
    expect(doc['model']).toEqual({
      requested: 'fake/jev',
      resolved: 'fake/jev-1',
      transport: 'fake-transport',
      pinned: true,
    });
    expect(doc['datasetHash']).toBe(lock.datasetHash);
    expect(doc['datasetHash']).toMatch(/^[0-9a-f]{64}$/);
  });

  test('report carries reasons, languages, byLanguage, se, correctedPassRate, ece, reliability, detail keys', async () => {
    const rows = standardRows();
    const root = await project(rows);
    const events = createEvents();
    const { judge } = countingJudge(rows, events);
    await vet(['validate'], depsFor(root, judge, events));

    const criteria = report()['criteria'];
    expect(Array.isArray(criteria)).toBe(true);
    const list: unknown[] = Array.isArray(criteria) ? criteria : [];
    const tone = isRecord(list[0]) ? list[0] : {};
    expect(tone).toMatchObject({
      id: 'tone',
      status: expect.any(String),
      reasons: expect.any(Array),
      languages: expect.any(Array),
      byLanguage: expect.any(Object),
      se: expect.any(Object),
      reliability: expect.any(Array),
      correctedPassRate: { valid: expect.any(Boolean) },
      gauntlet: expect.any(Object),
      detail: {
        paraphrase: { agreement: null, spread: null },
        injection: { families: {}, flipped: [] },
        master_key: { failedInputs: expect.any(Array) },
        position_swap: { consistency: expect.any(Number), inconclusive: expect.any(Number) },
        length: {
          paddingFlips: 0,
          truncationFlips: 0,
          lengthVerdictCorrelation: expect.any(Number),
        },
      },
    });
    const cpr = isRecord(tone['correctedPassRate']) ? tone['correctedPassRate'] : {};
    expect(Object.keys(cpr)).toEqual(expect.arrayContaining(['theta', 'ci95', 'valid']));
    expect(Object.hasOwn(tone, 'ece')).toBe(true);
    expect(tone['threshold']).toEqual(expect.any(Number));
    expect(tone['tolerance']).toEqual(expect.any(Number));
  });

  test('case at mean P = threshold gets 15 judge calls; P 0.99 gets 3', async () => {
    const rows = standardRows();
    const root = await project(rows);
    const events = createEvents();
    const counting = countingJudge(rows, events);
    await vet(['validate'], depsFor(root, counting.judge, events));

    expect(counting.calibrationCalls.get('S-border')).toBe(15);
    expect(counting.calibrationCalls.get('S-p0')).toBe(3);
    expect(counting.calibrationCalls.get('S-f0')).toBe(3);
    // No generator: paraphrase and polarity never ran. The shipped corpora
    // do run by default; only their pass/fail outcome depends on the mock judge.
    const g = (await lockAt(root)).criteria['tone']?.gauntlet;
    expect(g).toMatchObject({
      paraphrase: 'skipped',
      polarity: 'skipped',
      injection: 'pass',
      master_key: 'pass',
      constant_output: 'pass',
      length: 'pass',
    });
  });

  test('--repeats 1 is raised to 3', async () => {
    const rows = standardRows();
    const root = await project(rows);
    const events = createEvents();
    const codes: string[] = [];
    events.on('diag', ({ code }) => codes.push(code));
    const counting = countingJudge(rows, events);
    await vet(['validate', '--repeats', '1'], depsFor(root, counting.judge, events));

    expect(counting.calibrationCalls.get('S-p0')).toBe(3);
    expect(codes).toContain('REPEATS_RAISED');
  });

  test('--repeats 5 judges each case 5 times and tops band cases up to 15', async () => {
    const rows = standardRows();
    const root = await project(rows);
    const events = createEvents();
    const counting = countingJudge(rows, events);
    await vet(['validate', '--repeats', '5'], depsFor(root, counting.judge, events));

    expect(counting.calibrationCalls.get('S-p0')).toBe(5);
    expect(counting.calibrationCalls.get('S-border')).toBe(15);
  });

  test('--gauntlet <emptyDir> → injection skipped, criterion uncalibrated with reason injection', async () => {
    const rows = standardRows();
    const root = await project(rows);
    const dir = join(root, 'empty-gauntlet');
    await mkdir(dir, { recursive: true });
    const events = createEvents();
    const diags: string[] = [];
    events.on('diag', ({ level, code }) => diags.push(`${level}:${code}`));
    const { judge } = countingJudge(rows, events);
    await vet(['validate', '--gauntlet', dir], depsFor(root, judge, events));

    const entry = (await lockAt(root)).criteria['tone'];
    expect(entry?.gauntlet.injection).toBe('skipped');
    expect(entry?.status).toBe('uncalibrated');
    expect(entry?.reasons).toContain('injection');
    expect(diags).toContain('warn:GAUNTLET_CORPUS_MISSING');
  });

  test('an empty corpus file counts as missing', async () => {
    const rows = standardRows();
    const root = await project(rows);
    const dir = join(root, 'empty-injections-gauntlet');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'injections.json'), JSON.stringify({ version: 1, injections: [] }));
    const events = createEvents();
    const { judge } = countingJudge(rows, events);
    await vet(['validate', '--gauntlet', dir], depsFor(root, judge, events));

    expect((await lockAt(root)).criteria['tone']?.gauntlet.injection).toBe('skipped');
  });

  test('no --gauntlet flag defaults to the shipped corpora', async () => {
    const rows = standardRows();
    const root = await project(rows);
    const events = createEvents();
    const { judge } = countingJudge(rows, events);
    await vet(['validate'], depsFor(root, judge, events));

    const g = (await lockAt(root)).criteria['tone']?.gauntlet;
    expect(g?.injection).not.toBe('skipped');
    expect(g?.master_key).not.toBe('skipped');
    expect(g?.constant_output).not.toBe('skipped');
    expect(g?.length).not.toBe('skipped');
  });

  test('--gauntlet <dir> with the shipped corpora runs the corpus gauntlets', async () => {
    const rows = standardRows();
    const root = await project(rows);
    const dir = join(root, 'corpora');
    await mkdir(dir);
    for (const f of [
      'injections.json',
      'master-keys.json',
      'constant-outputs.json',
      'padding.json',
    ]) {
      await copyFile(join(repoRoot, 'fixtures/gauntlet', f), join(dir, f));
    }
    const events = createEvents();
    const { judge } = countingJudge(rows, events);
    await vet(['validate', '--gauntlet', dir], depsFor(root, judge, events));

    const g = (await lockAt(root)).criteria['tone']?.gauntlet;
    expect(g?.injection).not.toBe('skipped');
    expect(g?.master_key).not.toBe('skipped');
    expect(g?.constant_output).not.toBe('skipped');
    expect(g?.length).not.toBe('skipped');
  });

  test('a generator adapter from config drives the paraphrase gauntlet', async () => {
    const rows = standardRows();
    const root = await project(rows);
    const events = createEvents();
    const { judge } = countingJudge(rows, events);
    const doGenerate = vi.fn((req: { system?: string }) =>
      Promise.resolve(
        req.system?.includes('negation') === true
          ? { value: { negated: 'Is the reply not polite?' } }
          : {
              value: {
                paraphrases: [
                  'Is the reply courteous?',
                  'Does the reply sound polite?',
                  'Is the tone of the reply polite?',
                  'Would a reader call the reply polite?',
                ],
              },
            },
      ),
    );
    const generator: GeneratorAdapter = {
      specVersion: 'v1',
      id: 'fake-generator',
      capabilities: { structured: 'json_schema', streaming: false },
      doGenerate,
    };
    await vet(['validate'], depsFor(root, judge, events, generator));

    expect(doGenerate).toHaveBeenCalled();
    expect((await lockAt(root)).criteria['tone']?.gauntlet.paraphrase).not.toBe('skipped');
  });

  test('an invalid criteria file lists every issue with its pointer', async () => {
    const rows = standardRows();
    const root = await project(rows);
    const file = join(root, 'evals', 'criteria.yaml');
    await writeFile(
      file,
      `criteria:
  - id: first
    type: boolean
    instructions: Q1?
    escape: none
    channel: outcome
    provenance: { traceIds: [] }
  - id: second
    type: boolean
    instructions: Q2?
    polarity: pass_when_true
    channel: outcome
    provenance: { traceIds: [] }
`,
    );
    const events = createEvents();
    const { judge } = countingJudge(rows, events);
    const error = await rejection(vet(['validate'], depsFor(root, judge, events)));

    expect(exitCodeOf(error)).toBe(2);
    if (!VetError.isInstance(error)) throw new Error('expected a VetError');
    const lines = error.message.split('\n');
    expect(lines.some((l) => l.startsWith(`${file}/criteria/0/polarity: `))).toBe(true);
    expect(lines.some((l) => l.startsWith(`${file}/criteria/1/escape: `))).toBe(true);
  });

  test('an invalid cases directory lists every issue with file:line', async () => {
    const rows = standardRows();
    const root = await project(rows);
    const file = join(root, 'evals', 'cases', 'cases.jsonl');
    await writeFile(file, 'not json\n{"also": "bad"}\n');
    const events = createEvents();
    const { judge } = countingJudge(rows, events);
    const error = await rejection(vet(['validate'], depsFor(root, judge, events)));

    expect(exitCodeOf(error)).toBe(2);
    if (!VetError.isInstance(error)) throw new Error('expected a VetError');
    const lines = error.message.split('\n');
    expect(lines.some((l) => l.startsWith(`${file}:1: `))).toBe(true);
    expect(lines.some((l) => l.startsWith(`${file}:2: `))).toBe(true);
  });

  test('fewer than 100 labels: exits 2 LABELS_TOO_FEW with the count and writes no lock', async () => {
    const rows = standardRows().slice(0, 10);
    const root = await project(rows);
    const events = createEvents();
    const { judge } = countingJudge(rows, events);
    const error = await rejection(vet(['validate'], depsFor(root, judge, events)));

    expect(VetError.isInstance(error) && error.code).toBe(CEV_ERROR_CODES.LABELS_TOO_FEW);
    expect(VetError.isInstance(error) && error.message).toContain('tone: 10 labels (need 100)');
    expect(exitCodeOf(error)).toBe(2);
    await expect(lockAt(root)).rejects.toThrow();
    // The top-level handler renders the error document into the same stdout stream; under
    // --json the command itself must have written nothing before it.
    const rendered: string[] = [];
    const sink = { write: () => true };
    try {
      handleError(error, {
        json: true,
        verbose: false,
        strict: false,
        stdout: {
          write: (chunk: string) => {
            rendered.push(chunk);
            return true;
          },
        },
        stderr: sink,
        exit: () => {
          throw new Error('exit');
        },
      });
    } catch {
      // unwound by the exit double above
    }
    const docs = [...stdout, ...rendered]
      .join('')
      .split('\n')
      .filter((l) => l.trim() !== '');
    expect(docs).toHaveLength(1);
    const doc = parse(docs[0] ?? '');
    expect(doc['error']).toMatchObject({ code: CEV_ERROR_CODES.LABELS_TOO_FEW });
  });

  test('fewer than 100 labels with a pre-existing lock: the refusal leaves it untouched', async () => {
    const rows = standardRows().slice(0, 10);
    const root = await project(rows);
    const priorLock: Lock = {
      lockVersion: 1,
      model: {
        requested: 'legacy/jev',
        resolved: 'legacy/jev-1',
        transport: 'legacy-transport',
        pinned: true,
      },
      criteria: {
        tone: {
          wordingHash: 'c'.repeat(64),
          status: 'calibrated',
          threshold: 0.42,
          tpr: 0.9,
          tnr: 0.8,
          ece: 0.05,
          tolerance: 0.02,
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
          languages: ['en'],
          labelCount: 250,
        },
      },
      datasetHash: 'd'.repeat(64),
    };
    await writeFile(join(root, 'criteria.lock.json'), JSON.stringify(priorLock));
    const events = createEvents();
    const { judge } = countingJudge(rows, events);
    const error = await rejection(vet(['validate'], depsFor(root, judge, events)));

    expect(VetError.isInstance(error) && error.code).toBe(CEV_ERROR_CODES.LABELS_TOO_FEW);
    expect(await lockAt(root)).toEqual(priorLock);
  });

  test('--lock <path> writes the lock there', async () => {
    const rows = standardRows();
    const root = await project(rows);
    const events = createEvents();
    const { judge } = countingJudge(rows, events);
    const target = join(root, 'elsewhere.lock.json');
    await vet(['validate', '--lock', target], depsFor(root, judge, events));

    const r = await readLock(target);
    expect('error' in r).toBe(false);
  });

  test('a criterion with enabled: false is never judged and gets no lock entry', async () => {
    const rows = standardRows();
    const root = await project(rows);
    await writeFile(
      join(root, 'evals', 'criteria.yaml'),
      `${CRITERIA_YAML}  - id: extra
    type: boolean
    instructions: Is the reply extra?
    escape: The reply has no discernible tone.
    polarity: pass_when_true
    channel: quality
    enabled: false
    provenance:
      traceIds: []
`,
    );
    const events = createEvents();
    const { judge } = countingJudge(rows, events);
    const seenCriteria = new Set<string>();
    const spying: JudgeV1 = {
      ...judge,
      doJudge: (req) => {
        for (const k of Object.keys(req.questions)) seenCriteria.add(k);
        return judge.doJudge(req);
      },
    };
    await vet(['validate'], depsFor(root, spying, events));

    expect(seenCriteria).toEqual(new Set(['tone']));
    const lock = await lockAt(root);
    expect(lock.criteria['extra']).toBeUndefined();
    expect(lock.criteria['tone']?.labelCount).toBe(200);
  });

  test('a pre-existing lock entry for a disabled criterion survives validate unchanged', async () => {
    const rows = standardRows();
    const root = await project(rows);
    await writeFile(
      join(root, 'evals', 'criteria.yaml'),
      `${CRITERIA_YAML}  - id: extra
    type: boolean
    instructions: Is the reply extra?
    escape: The reply has no discernible tone.
    polarity: pass_when_true
    channel: quality
    enabled: false
    provenance:
      traceIds: []
`,
    );
    const priorEntry: LockCriterion = {
      wordingHash: 'c'.repeat(64),
      status: 'calibrated',
      threshold: 0.42,
      tpr: 0.9,
      tnr: 0.8,
      ece: 0.05,
      tolerance: 0.02,
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
      languages: ['en'],
      labelCount: 250,
    };
    const priorLock: Lock = {
      lockVersion: 1,
      model: {
        requested: 'legacy/jev',
        resolved: 'legacy/jev-1',
        transport: 'legacy-transport',
        pinned: true,
      },
      criteria: { extra: priorEntry },
      datasetHash: 'd'.repeat(64),
    };
    await writeFile(join(root, 'criteria.lock.json'), JSON.stringify(priorLock));
    const events = createEvents();
    const { judge } = countingJudge(rows, events);
    await vet(['validate'], depsFor(root, judge, events));

    const lock = await lockAt(root);
    expect(lock.criteria['extra']).toEqual(priorEntry);
  });
});

describe('gate module with a validate-written lock', () => {
  test('gate module: uncalibrated referenced criterion → exit 2 GATE_UNCALIBRATED with id', async () => {
    const rows = standardRows();
    const root = await project(rows);
    const events = createEvents();
    const { judge } = countingJudge(rows, events);
    await vet(['validate'], depsFor(root, judge, events));
    const lock = await lockAt(root);
    expect(lock.criteria['tone']?.status).toBe('uncalibrated');

    const r = assertLockGates(
      lock,
      { requireCalibrated: true },
      { gate: true, criterionIds: ['tone'] },
    );
    expect(r).toMatchObject({ ok: false, code: 'GATE_UNCALIBRATED', criterionId: 'tone' });
    if (!r.ok) expect(exitCodeOf(new VetError(r.code, r.message))).toBe(2);
  });
});

interface Spawned {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number | null;
}

function runVet(args: readonly string[], cwd: string): Spawned {
  return spawnSync(process.execPath, [binPath, ...args], {
    cwd,
    env: { ...process.env, NO_COLOR: '1', VETKIT_FIXTURE_MODE: 'pass' },
    encoding: 'utf8',
  });
}

// The run fixture's in-process judge is unpinned (transport 'fake'), criterion 'tone'; the planted
// lock hashes the fixture's wording and names the default request format, as vet validate would.
function runProject(status?: 'floating' | 'uncalibrated'): string {
  const dir = mkdtempSync(join(tmpdir(), 'vetkit-validate-run-'));
  cpSync(runFixture, dir, { recursive: true });
  if (status !== undefined) {
    const lock: Lock = {
      lockVersion: 1,
      model: {
        requested: 'fake-jev-pass',
        resolved: 'fake-jev-pass-resolved',
        transport: 'fake',
        pinned: false,
      },
      criteria: {
        tone: {
          wordingHash: computeWordingHash({
            type: 'boolean',
            instructions: 'Is the reply polite?',
            escape: 'The reply has no discernible tone.',
          }),
          status,
          threshold: 0.5,
          tolerance: 0.02,
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
      requestFormat: 'fenced-v1',
    };
    writeFileSync(join(dir, 'criteria.lock.json'), JSON.stringify(lock));
  }
  return dir;
}

describe('vet run gate with a lock file (spawned)', () => {
  beforeAll(async () => {
    await ensureCliBuilt();
  }, 180_000);

  test('--gate with no lock names criteria.lock.json on stderr', () => {
    const result = runVet(['run', '--json', '--gate'], runProject());
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('criteria.lock.json');
  });

  test('--gate --allow-unpinned reads criteria.lock.json and accepts a floating entry', () => {
    const result = runVet(['run', '--json', '--gate', '--allow-unpinned'], runProject('floating'));
    expect(result.stderr).not.toContain('gate refused');
    expect(result.status).toBe(0);
  });

  test('--gate with an uncalibrated lock entry exits 2 with GATE_UNCALIBRATED naming the id', () => {
    const result = runVet(
      ['run', '--json', '--gate', '--allow-unpinned'],
      runProject('uncalibrated'),
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('GATE_UNCALIBRATED');
    expect(result.stderr).toContain("'tone'");
  });

  test('--ci floating lock → exit 2 GATE_UNPINNED; --allow-unpinned passes', () => {
    const refused = runVet(['run', '--json', '--ci'], runProject('floating'));
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain('GATE_UNPINNED');

    const allowed = runVet(['run', '--json', '--ci', '--allow-unpinned'], runProject('floating'));
    expect(allowed.status).toBe(0);
  });

  test('smoke: vet validate --json prints a report whose .model parses', () => {
    const dir = runProject();
    const ids = Array.from({ length: 100 }, (_, i) => `case-${String(i)}`);
    writeFileSync(
      join(dir, 'evals', 'cases', 'cases.jsonl'),
      `${ids.map((id) => JSON.stringify({ id, input: { state: `User: hi ${id}` }, provenance: null, tags: [] })).join('\n')}\n`,
    );
    const labelsDir = join(dir, 'evals', 'labels');
    mkdirSync(labelsDir, { recursive: true });
    writeFileSync(
      join(labelsDir, 'tone.csv'),
      `${[HEADER, ...ids.map((id) => `${id},tone,pass,tester,2026-09-28T00:00:00Z`)].join('\n')}\n`,
    );
    const result = runVet(['validate', '--json'], dir);
    expect(result.status).toBe(0);
    const first = result.stdout.split('\n').find((l) => l.trim() !== '') ?? '';
    expect(parse(first)['model']).toMatchObject({
      resolved: 'fake-jev-pass-resolved',
      pinned: false,
    });
  });
});

// The judge answers only for cases whose id is in `answering`; every other call fails with a
// non-retryable JUDGE_UNAVAILABLE, so the criterion is scored on a small subset.
function flakyJudge(rows: readonly Row[], answering: ReadonlySet<string>): JudgeV1 {
  const base = countingJudge(rows, createEvents()).judge;
  return {
    ...base,
    doJudge: (req) =>
      answering.has(req.state.replace(/^S-/, ''))
        ? base.doJudge(req)
        : Promise.reject(new VetError(CEV_ERROR_CODES.JUDGE_UNAVAILABLE, 'down')),
  };
}

function toneEntry(): Record<string, unknown> {
  const list = report()['criteria'];
  const first: unknown = Array.isArray(list) ? list[0] : undefined;
  if (!isRecord(first)) throw new Error('no criterion in report');
  return first;
}

describe('vet validate judge outage', () => {
  test('90% of judge calls failing: report names judge_unavailable with unscored count and cause codes', async () => {
    const rows = standardRows();
    const root = await project(rows);
    const events = createEvents();
    const answering = new Set([...rows.slice(0, 10), ...rows.slice(100, 110)].map((r) => r.id));
    await vet(['validate'], depsFor(root, flakyJudge(rows, answering), events));

    const tone = toneEntry();
    expect(tone['reasons']).toContain('judge_unavailable');
    expect(tone['reasons']).not.toContain('single_class');
    expect(tone['reasons']).not.toContain('class_too_small');
    expect(tone['unscored']).toMatchObject({
      count: 540,
      total: 600,
      causes: [CEV_ERROR_CODES.JUDGE_UNAVAILABLE],
    });
  });

  test('every judged case scored: unscored is zero and judge_unavailable is absent', async () => {
    const rows = standardRows();
    const root = await project(rows);
    const events = createEvents();
    const { judge } = countingJudge(rows, events);
    await vet(['validate'], depsFor(root, judge, events));

    const tone = toneEntry();
    expect(tone['reasons']).not.toContain('judge_unavailable');
    expect(tone['unscored']).toMatchObject({ count: 0, causes: [] });
  });
});

// Runs validate with info logging on, recording stderr lines and judge:request events in order.
async function orderedRun(
  root: string,
  judge: JudgeV1,
  events: Events,
): Promise<{ order: string[]; text: string; error?: unknown }> {
  const order: string[] = [];
  const out: string[] = [];
  events.on('judge:request', () => order.push('judge:request'));
  configureOutput({ json: true });
  const err = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    order.push(`stderr:${String(chunk).trimEnd()}`);
    return true;
  });
  const std = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  const program = new Command();
  program.exitOverride().option('--json');
  registerValidate(program, depsFor(root, judge, events));
  let error: unknown;
  try {
    await program.parseAsync(['node', 'vet', '--json', 'validate']);
  } catch (caught) {
    error = caught;
  } finally {
    err.mockRestore();
    std.mockRestore();
  }
  return { order, text: out.join(''), ...(error === undefined ? {} : { error }) };
}

describe('validate preflight', () => {
  const LABELLED = 100;
  const ESTIMATE_LINE =
    /estimate: 300 judge calls, ~\d+ input tokens, cost unknown, ~12\.0 min at 25 calls\/min \(breakdown: vet estimate --for validate\)/;

  function labelledRows(): Row[] {
    const rows: Row[] = [];
    for (let i = 0; i < LABELLED / 2; i += 1)
      rows.push({ id: `p${String(i)}`, p: 0.99, label: 'pass' });
    for (let i = 0; i < LABELLED / 2; i += 1)
      rows.push({ id: `f${String(i)}`, p: 0.01, label: 'fail' });
    return rows;
  }

  test('prints the estimate line before the first judge call (event order asserted)', async () => {
    const rows = labelledRows();
    const root = await project(rows);
    const events = createEvents();
    const { judge } = countingJudge(rows, events);
    const { order } = await orderedRun(root, judge, events);

    const estimateAt = order.findIndex((l) => ESTIMATE_LINE.test(l));
    const firstJudge = order.indexOf('judge:request');
    const firstCase = order.findIndex((l) => /^stderr:.*\bcase \S+ \(1\//.test(l));
    expect(estimateAt).toBeGreaterThanOrEqual(0);
    expect(firstJudge).toBeGreaterThan(estimateAt);
    expect(firstCase === -1 || firstCase > estimateAt).toBe(true);
    expect(order.filter((l) => ESTIMATE_LINE.test(l))).toHaveLength(1);
  });

  test('--json carries estimate {calls, inputTokens, cost, minutes}', async () => {
    const rows = labelledRows();
    const root = await project(rows);
    const events = createEvents();
    const { judge } = countingJudge(rows, events);
    const { text } = await orderedRun(root, judge, events);

    const doc = parse(text.split('\n').find((l) => l.trim() !== '') ?? '');
    const estimate = doc['estimate'];
    expect(isRecord(estimate)).toBe(true);
    expect(estimate).toMatchObject({ calls: 300, cost: 'unknown', minutes: 12 });
    expect(estimate).toEqual({
      calls: 300,
      inputTokens: expect.any(Number),
      cost: 'unknown',
      minutes: 12,
    });
    expect(isRecord(estimate) ? estimate['inputTokens'] : 0).toBeGreaterThan(0);
  });

  test('cost is unknown for a transport with no pricing row', async () => {
    const rows = labelledRows();
    const root = await project(rows);
    const events = createEvents();
    const { judge } = countingJudge(rows, events, { transport: 'in-process-custom' });
    const { order } = await orderedRun(root, judge, events);

    expect(order.some((l) => /estimate: 300 judge calls, .*cost unknown/.test(l))).toBe(true);
  });

  test('a demo transport exits 2 GATE_REFUSED and writes no lock', async () => {
    const rows = labelledRows();
    const root = await project(rows);
    const events = createEvents();
    const counting = countingJudge(rows, events, { transport: 'demo' });
    const { error } = await orderedRun(root, counting.judge, events);

    expect(error).toBeInstanceOf(VetError);
    expect(error).toMatchObject({
      code: CEV_ERROR_CODES.GATE_REFUSED,
      message: 'demo judge verdicts are never locked; set a real judge key (see `vet init`)',
    });
    expect(exitCodeOf(error)).toBe(2);
    expect(counting.total).toBe(0);
    await expect(lockAt(root)).rejects.toBeDefined();
  });

  test('a demo transport with an existing lock leaves it byte-identical', async () => {
    const rows = labelledRows();
    const root = await project(rows);
    const lockFile = join(root, 'criteria.lock.json');
    const existing: Lock = {
      lockVersion: 1,
      model: { requested: 'real/jev', resolved: 'real/jev-1', transport: 'real', pinned: true },
      criteria: {},
      datasetHash: 'd'.repeat(64),
    };
    await writeFile(lockFile, `${JSON.stringify(existing)}\n`);
    const before = await readFile(lockFile);
    const events = createEvents();
    const counting = countingJudge(rows, events, { transport: 'demo' });
    const { error } = await orderedRun(root, counting.judge, events);

    expect(exitCodeOf(error)).toBe(2);
    expect(counting.total).toBe(0);
    expect((await readFile(lockFile)).equals(before)).toBe(true);
  });
});
