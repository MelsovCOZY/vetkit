import { mkdir, mkdtemp, readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  CEV_ERROR_CODES,
  VetError,
  type Case,
  type Criterion,
  type GauntletResult,
  type JudgeResponse,
  type Lock,
  type LockCriterion,
} from '@vetkit/spec';
import { computeWordingHash } from '../criteria/load.ts';
import { createEvents } from '../events.ts';
import type { CalibrationResult } from './calibrate.ts';
import {
  assertLockGates,
  buildLock,
  checkLock,
  datasetHash,
  lockEntryGateable,
  readLock,
  readLockOrNull,
  writeLockAtomic,
  type LockInputs,
} from './lock.ts';

// ---------- fixtures ----------

function criterion(over: Partial<Criterion> = {}): Criterion {
  const base = {
    id: 'answers-question',
    type: 'boolean',
    instructions: 'Does the reply answer the question?',
    escape: 'The reply is empty.',
    polarity: 'pass_when_true',
    channel: 'outcome',
    provenance: { traceIds: [] },
    ...over,
  } as const;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const c = base as unknown as Criterion;
  return { ...c, wordingHash: computeWordingHash(c) };
}

function scoreCriterion(): Criterion {
  const c: Criterion = {
    id: 'helpfulness',
    type: 'score',
    instructions: 'How helpful is the reply?',
    criteria: ['not helpful', 'very helpful'],
    polarity: 'pass_when_true',
    channel: 'quality',
    provenance: { traceIds: [] },
    wordingHash: '',
  };
  return { ...c, wordingHash: computeWordingHash(c) };
}

function calibration(over: Partial<CalibrationResult> = {}): CalibrationResult {
  return {
    threshold: 0.5,
    tpr: 0.9,
    tnr: 0.88,
    se: { tpr: 0.03, tnr: 0.04 },
    ece: 0.02,
    reliability: [],
    tolerance: 0.05,
    heldOut: { tp: 45, fn: 5, tn: 44, fp: 6 },
    split: { train: [], heldOut: [] },
    byLanguage: {},
    languages: ['en'],
    status: 'calibrated',
    reasons: [],
    labelCount: 120,
    ...over,
  };
}

const ALL_PASS: GauntletResult = {
  paraphrase: 'pass',
  polarity: 'pass',
  injection: 'pass',
  master_key: 'pass',
  label_permutation: 'pass',
  constant_output: 'pass',
  position_swap: 'pass',
  length: 'pass',
};

const PINNED: JudgeResponse['model'] = {
  requested: 'judge-a',
  resolved: 'judge-a-2026',
  transport: 'transport-a',
  pinned: true,
  provider: 'someone',
  credentialType: 'key',
  releaseDate: '2026-09-15',
};

function cases(): Case[] {
  return [
    { id: 'c2', input: { state: 'S2' }, provenance: null, tags: [], language: 'en' },
    {
      id: 'c1',
      input: { state: 'S1', answer: '4' },
      provenance: null,
      tags: [],
      expected: { value: '4', source: 'user' },
      language: 'en',
      cluster: 'k1',
    },
  ];
}

function inputs(over: Partial<LockInputs> = {}, c: Criterion = criterion()): LockInputs {
  return {
    model: PINNED,
    criteria: [c],
    cases: cases(),
    results: { [c.id]: { calibration: calibration(), gauntlet: ALL_PASS } },
    ...over,
  };
}

function entryOf(lock: Lock, id = 'answers-question'): LockCriterion {
  const e = lock.criteria[id];
  if (e === undefined) throw new Error(`no entry ${id}`);
  return e;
}

// ---------- buildLock status matrix ----------

describe('buildLock', () => {
  test('status matrix: calibrated only when all conditions hold', () => {
    const lock = buildLock(inputs());
    expect(lock.lockVersion).toBe(1);
    expect(entryOf(lock)).toMatchObject({
      status: 'calibrated',
      reasons: [],
      languages: ['en'],
      threshold: 0.5,
      tpr: 0.9,
      tnr: 0.88,
      ece: 0.02,
      tolerance: 0.05,
      labelCount: 120,
      gauntlet: ALL_PASS,
    });
    expect(entryOf(lock).wordingHash).toBe(criterion().wordingHash);
  });

  const failing: [string, LockInputs, string][] = [
    [
      'calibrate class_too_small',
      inputs({
        results: {
          'answers-question': {
            calibration: calibration({ status: 'uncalibrated', reasons: ['class_too_small'] }),
            gauntlet: ALL_PASS,
          },
        },
      }),
      'class_too_small',
    ],
    [
      'labelCount below 100',
      inputs({
        results: {
          'answers-question': { calibration: calibration({ labelCount: 40 }), gauntlet: ALL_PASS },
        },
      }),
      'too_few_labels',
    ],
    [
      'constant_output gauntlet fails',
      inputs({
        results: {
          'answers-question': {
            calibration: calibration(),
            gauntlet: { ...ALL_PASS, constant_output: 'fail' },
          },
        },
      }),
      'constant_output',
    ],
    [
      'injection gauntlet skipped',
      inputs({
        results: {
          'answers-question': {
            calibration: calibration(),
            gauntlet: { ...ALL_PASS, injection: 'skipped' },
          },
        },
      }),
      'injection',
    ],
  ];
  test.each(failing)('status matrix: %s → uncalibrated with its reason', (_name, input, reason) => {
    const e = entryOf(buildLock(input));
    expect(e.status).toBe('uncalibrated');
    expect(e.reasons).toContain(reason);
  });

  test('a gauntlet key missing from the input is recorded skipped and named in reasons', () => {
    const { length: _drop, ...partial } = ALL_PASS;
    const e = entryOf(
      buildLock(
        inputs({
          results: { 'answers-question': { calibration: calibration(), gauntlet: partial } },
        }),
      ),
    );
    expect(e.gauntlet.length).toBe('skipped');
    expect(e.reasons).toContain('length');
    expect(e.status).toBe('uncalibrated');
  });

  test('code grader: gauntlet recorded skipped, still calibrated', () => {
    const c = criterion({ checkable: 'math', grader: { kind: 'code', check: 'numeric' } });
    // A code grader needs a reference on every case (referenceRequirement).
    const referenced = cases().map((k) => ({
      ...k,
      expected: { value: '4', source: 'user' as const },
    }));
    const e = entryOf(
      buildLock(
        inputs(
          { cases: referenced, results: { [c.id]: { calibration: calibration(), gauntlet: {} } } },
          c,
        ),
      ),
    );
    expect(Object.values(e.gauntlet).every((g) => g === 'skipped')).toBe(true);
    expect(e.status).toBe('calibrated');
    expect(e.reasons).toEqual([]);
  });

  test('score criterion → uncalibrated score_not_gateable, metrics kept', () => {
    const c = scoreCriterion();
    const e = entryOf(
      buildLock(
        inputs({ results: { [c.id]: { calibration: calibration(), gauntlet: ALL_PASS } } }, c),
      ),
      'helpfulness',
    );
    expect(e.status).toBe('uncalibrated');
    expect(e.reasons).toContain('score_not_gateable');
    expect(e).toMatchObject({ threshold: 0.5, tpr: 0.9, tnr: 0.88 });
  });

  test('reference_missing when checkable without grader', () => {
    const c = criterion({ checkable: 'factual' });
    const e = entryOf(buildLock(inputs({}, c)));
    expect(e.status).toBe('uncalibrated');
    expect(e.reasons).toContain('reference_missing');
  });

  test('floating when model.pinned false', () => {
    const lock = buildLock(inputs({ model: { ...PINNED, pinned: false } }));
    expect(entryOf(lock).status).toBe('floating');
  });

  test('a failing entry stays uncalibrated under an unpinned model', () => {
    const lock = buildLock(
      inputs({
        model: { ...PINNED, pinned: false },
        results: {
          'answers-question': {
            calibration: calibration(),
            gauntlet: { ...ALL_PASS, polarity: 'fail' },
          },
        },
      }),
    );
    expect(entryOf(lock).status).toBe('uncalibrated');
  });

  test('model drops provider and credentialType, keeps releaseDate', () => {
    const lock = buildLock(inputs());
    expect(lock.model).toEqual({
      requested: 'judge-a',
      resolved: 'judge-a-2026',
      transport: 'transport-a',
      pinned: true,
      releaseDate: '2026-09-15',
    });
  });

  test('undefined metrics are omitted, never written', () => {
    const {
      threshold: _t,
      tpr: _p,
      tnr: _n,
      ece: _e,
      tolerance: _o,
      ...bare
    } = calibration({
      status: 'uncalibrated',
      reasons: ['single_class'],
    });
    const e = entryOf(
      buildLock(
        inputs({ results: { 'answers-question': { calibration: bare, gauntlet: ALL_PASS } } }),
      ),
    );
    expect(Object.hasOwn(e, 'threshold')).toBe(false);
    expect(Object.hasOwn(e, 'tpr')).toBe(false);
  });
});

// ---------- hashes ----------

describe('hashes', () => {
  test('wordingHash and datasetHash stable across key order', () => {
    const a = criterion();
    const reordered = Object.fromEntries(Object.entries(a).toReversed());
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    expect(computeWordingHash(reordered as unknown as Criterion)).toBe(a.wordingHash);

    const shuffled = cases().map(
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      (c) => Object.fromEntries(Object.entries(c).toReversed()) as unknown as Case,
    );
    expect(datasetHash(shuffled)).toBe(datasetHash(cases()));
    expect(datasetHash(cases().toReversed())).toBe(datasetHash(cases()));
    expect(datasetHash(cases())).toMatch(/^[0-9a-f]{64}$/);
  });

  test('datasetHash changes when expected.value / language / cluster changes', () => {
    const base = datasetHash(cases());
    const edit = (f: (c: Case) => Case): string =>
      datasetHash(cases().map((c) => (c.id === 'c1' ? f(c) : c)));
    expect(edit((c) => ({ ...c, expected: { value: '5', source: 'user' } }))).not.toBe(base);
    expect(edit((c) => ({ ...c, language: 'kk' }))).not.toBe(base);
    expect(edit((c) => ({ ...c, cluster: 'k2' }))).not.toBe(base);
    expect(edit((c) => ({ ...c, input: { state: 'S1 edited' } }))).not.toBe(base);
  });

  test('datasetHash ignores tags and provenance', () => {
    const base = datasetHash(cases());
    expect(datasetHash(cases().map((c) => ({ ...c, tags: ['x'], provenance: { a: 1 } })))).toBe(
      base,
    );
  });
});

// ---------- write / read ----------

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'vetkit-lock-'));
}

describe('writeLockAtomic / readLock', () => {
  test('writeLockAtomic uses temp+rename and warns on concurrent overwrite', async () => {
    const dir = await tmp();
    const path = join(dir, 'criteria.lock.json');
    const lock = buildLock(inputs());
    await writeLockAtomic(path, lock);
    expect(await readdir(dir)).toEqual(['criteria.lock.json']);
    const read = await readLock(path);
    expect(read).toEqual(lock);

    // Another writer replaced the file after this run started: warn, last writer wins.
    const since = Date.now() - 60_000;
    const past = new Date(since - 60_000);
    await utimes(path, past, past);
    const quiet: string[] = [];
    const e1 = createEvents();
    e1.on('diag', ({ code }) => quiet.push(code));
    await writeLockAtomic(path, lock, { events: e1, since });
    expect(quiet).not.toContain('LOCK_OVERWRITTEN');

    await writeFile(path, '{}');
    const codes: string[] = [];
    const e2 = createEvents();
    e2.on('diag', ({ code }) => codes.push(code));
    await writeLockAtomic(path, lock, { events: e2, since });
    expect(codes).toContain('LOCK_OVERWRITTEN');
    expect(await readLock(path)).toEqual(lock);
  });

  test('the temp file is removed on write failure', async () => {
    const dir = await tmp();
    const path = join(dir, 'criteria.lock.json');
    await mkdir(join(path, 'occupied'), { recursive: true });
    await expect(writeLockAtomic(path, buildLock(inputs()))).rejects.toThrow();
    expect((await readdir(dir)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    expect((await stat(path)).isDirectory()).toBe(true);
  });

  test('writes pretty JSON ending in a newline', async () => {
    const dir = await tmp();
    const path = join(dir, 'criteria.lock.json');
    await writeLockAtomic(path, buildLock(inputs()));
    const text = await readFile(path, 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    expect(text).toContain('\n  "lockVersion": 1');
  });

  test('readLock rejects bad schema and lockVersion 2', async () => {
    const dir = await tmp();
    const bad = join(dir, 'bad.json');
    await writeFile(bad, JSON.stringify({ ...buildLock(inputs()), lockVersion: 2 }));
    const r1 = await readLock(bad);
    expect('error' in r1 && r1.error.code).toBe(CEV_ERROR_CODES.E_SCHEMA_INVALID);

    const junk = join(dir, 'junk.json');
    await writeFile(junk, '{not json');
    const r2 = await readLock(junk);
    expect('error' in r2 && r2.error.code).toBe(CEV_ERROR_CODES.E_JSON_PARSE);

    const r3 = await readLock(join(dir, 'missing.json'));
    expect('error' in r3 && r3.error.code).toBe(CEV_ERROR_CODES.CONFIG_INVALID);
    expect('error' in r3 && r3.error.message).toContain('missing.json');
  });

  test('readLockOrNull: missing → null, invalid → throws, valid → lock (q4q.11)', async () => {
    const dir = await tmp();
    expect(await readLockOrNull(join(dir, 'criteria.lock.json'))).toBeNull();
    const junk = join(dir, 'junk.json');
    await writeFile(junk, '{not json');
    await expect(readLockOrNull(junk)).rejects.toBeInstanceOf(VetError);
    const good = join(dir, 'good.json');
    const lock = buildLock(inputs());
    await writeLockAtomic(good, lock);
    expect(await readLockOrNull(good)).toEqual(lock);
  });
});

// ---------- gate assertions ----------

function lockWith(criteria: Record<string, Partial<LockCriterion>>, pinned = true): Lock {
  const base = entryOf(buildLock(inputs()));
  return {
    lockVersion: 1,
    model: { requested: 'judge-a', resolved: 'judge-a-2026', transport: 'transport-a', pinned },
    criteria: Object.fromEntries(
      Object.entries(criteria).map(([id, e]) => [id, { ...base, ...e }]),
    ),
    datasetHash: 'a'.repeat(64),
  };
}

const POLICY = { requireCalibrated: true } as const;

describe('assertLockGates', () => {
  test('assertLockGates: GATE_UNCALIBRATED names id; GATE_UNPINNED on floating --ci; allowUnpinned passes', () => {
    const lock = lockWith({ a: {}, b: { status: 'uncalibrated' } });
    const r1 = assertLockGates(lock, POLICY, { gate: true, criterionIds: ['a', 'b'] });
    expect(r1).toMatchObject({ ok: false, code: 'GATE_UNCALIBRATED', criterionId: 'b' });
    expect(!r1.ok && r1.message).toContain("'b'");
    expect(!r1.ok && r1.message).toContain('criteria.lock.json');

    const floating = lockWith({ a: { status: 'floating' } }, false);
    const r2 = assertLockGates(floating, POLICY, { ci: true, criterionIds: ['a'] });
    expect(r2).toMatchObject({ ok: false, code: 'GATE_UNPINNED' });
    expect(!r2.ok && r2.message).toContain('--allow-unpinned');

    const r3 = assertLockGates(floating, POLICY, {
      ci: true,
      gate: true,
      allowUnpinned: true,
      criterionIds: ['a'],
    });
    expect(r3).toEqual({ ok: true });
  });

  test('floating entries fail --gate without --allow-unpinned', () => {
    const floating = lockWith({ a: { status: 'floating' } }, false);
    expect(assertLockGates(floating, POLICY, { gate: true, criterionIds: ['a'] })).toMatchObject({
      ok: false,
      code: 'GATE_UNCALIBRATED',
      criterionId: 'a',
    });
  });

  test('criterion added after lock → missing entry uncalibrated at gate', () => {
    const lock = lockWith({ a: {} });
    expect(
      assertLockGates(lock, POLICY, { gate: true, criterionIds: ['a', 'new-one'] }),
    ).toMatchObject({ ok: false, code: 'GATE_UNCALIBRATED', criterionId: 'new-one' });
  });

  test('requireCalibrated false or no --gate skips the calibration check', () => {
    const lock = lockWith({ b: { status: 'uncalibrated' } });
    expect(
      assertLockGates(lock, { requireCalibrated: false }, { gate: true, criterionIds: ['b'] }),
    ).toEqual({ ok: true });
    expect(assertLockGates(lock, POLICY, { criterionIds: ['b'] })).toEqual({ ok: true });
  });

  test('lockEntryGateable: calibrated always, floating only with allowUnpinned', () => {
    const base = entryOf(buildLock(inputs()));
    expect(lockEntryGateable(base, false)).toBe(true);
    expect(lockEntryGateable({ ...base, status: 'floating' }, false)).toBe(false);
    expect(lockEntryGateable({ ...base, status: 'floating' }, true)).toBe(true);
    expect(lockEntryGateable({ ...base, status: 'uncalibrated' }, true)).toBe(false);
    expect(lockEntryGateable(undefined, true)).toBe(false);
  });
});

// ---------- checkLock ----------

function current(
  over: Partial<Parameters<typeof checkLock>[1]> = {},
): Parameters<typeof checkLock>[1] {
  return { criteria: [criterion()], cases: cases(), ...over };
}

describe('checkLock', () => {
  test('a fresh lock is not stale', () => {
    const lock = buildLock(inputs());
    const report = checkLock(
      lock,
      current({ model: { transport: 'transport-a', releaseDate: '2026-09-15' } }),
    );
    expect(report).toMatchObject({ stale: false, reasons: [], releaseDate: 'match' });
  });

  test('checkLock stale reasons wordingHash|datasetHash|releaseDate; releaseDate unknown when no describeModel', () => {
    const lock = buildLock(inputs());
    const reworded = criterion({ instructions: 'Does the reply fully answer the question?' });
    expect(checkLock(lock, current({ criteria: [reworded] }))).toMatchObject({
      stale: true,
      reasons: ['wordingHash'],
      criteria: ['answers-question'],
    });

    const edited = cases().map((c) => ({ ...c, language: 'kk' }));
    expect(checkLock(lock, current({ cases: edited }))).toMatchObject({
      stale: true,
      reasons: ['datasetHash'],
    });

    expect(
      checkLock(lock, current({ model: { transport: 'transport-a', releaseDate: '2026-10-01' } })),
    ).toMatchObject({ stale: true, reasons: ['releaseDate'], releaseDate: 'differs' });

    expect(
      checkLock(lock, current({ model: { transport: 'transport-a', releaseDate: null } })),
    ).toMatchObject({ stale: false, releaseDate: 'unknown' });
    expect(checkLock(lock, current())).toMatchObject({ stale: false, releaseDate: 'unknown' });
  });

  test('transport A lock, transport B judge → stale, reasons [transport]', () => {
    const lock = buildLock(inputs());
    expect(checkLock(lock, current({ model: { transport: 'transport-b' } }))).toMatchObject({
      stale: true,
      reasons: ['transport'],
    });
  });

  test('a criterion added after the lock makes the wording stale', () => {
    const lock = buildLock(inputs());
    const extra = criterion({ id: 'extra' });
    const report = checkLock(lock, current({ criteria: [criterion(), extra] }));
    expect(report.stale).toBe(true);
    expect(report.reasons).toContain('wordingHash');
    expect(report.criteria).toContain('extra');
  });
});
