import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, expectTypeOf, test } from 'vitest';
import { safeParseJson } from '../json.ts';
import type { GauntletResult, Lock, LockCriterion, LockModel, LockReason } from './index.ts';
import { lockSchema } from './schemas.ts';

const SCHEMAS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'schemas');
const HASH = 'a'.repeat(64);

type Json = Record<string, unknown>;

function gauntlet(): Json {
  return {
    paraphrase: 'pass',
    polarity: 'pass',
    injection: 'fail',
    master_key: 'pass',
    label_permutation: 'pass',
    constant_output: 'skipped',
    position_swap: 'pass',
    length: 'pass',
  };
}

function criterion(overrides: Json = {}): Json {
  return {
    wordingHash: HASH,
    status: 'calibrated',
    threshold: 0.5,
    tpr: 0.9,
    tnr: 0.85,
    ece: 0.04,
    tolerance: 0.05,
    gauntlet: gauntlet(),
    reasons: [],
    languages: ['en'],
    labelCount: 80,
    ...overrides,
  };
}

function lock(overrides: Json = {}): Json {
  return {
    lockVersion: 1,
    model: {
      requested: 'typesafe-ai/jev',
      resolved: 'jev',
      transport: 'vercel-gateway',
      pinned: false,
      releaseDate: '2026-09-15',
    },
    criteria: { 'no-refunds': criterion() },
    datasetHash: HASH,
    ...overrides,
  };
}

function parse(value: unknown) {
  return safeParseJson<Lock>(JSON.stringify(value), lockSchema);
}

describe('lockSchema', () => {
  test('accepts the valid fixture', () => {
    expect(parse(lock()).ok).toBe(true);
  });

  test('rejects lockVersion 2', () => {
    expect(parse(lock({ lockVersion: 2 })).ok).toBe(false);
  });

  test("rejects an unknown status 'ok'", () => {
    expect(parse(lock({ criteria: { c: criterion({ status: 'ok' }) } })).ok).toBe(false);
  });

  test('rejects a lock missing datasetHash', () => {
    const { datasetHash: _omit, ...rest } = lock();
    expect(parse(rest).ok).toBe(false);
  });

  test("rejects the renamed gauntlet key 'null_model'", () => {
    const g = { ...gauntlet(), null_model: 'pass' };
    expect(parse(lock({ criteria: { c: criterion({ gauntlet: g }) } })).ok).toBe(false);
  });

  test("rejects an unknown reason 'foo'", () => {
    expect(parse(lock({ criteria: { c: criterion({ reasons: ['foo'] }) } })).ok).toBe(false);
  });

  test("accepts reasons ['class_too_small', 'constant_output']", () => {
    const c = criterion({
      status: 'uncalibrated',
      reasons: ['class_too_small', 'constant_output'],
    });
    expect(parse(lock({ criteria: { c } })).ok).toBe(true);
  });

  test('rejects tpr: null (undefined metrics are omitted, never written as null)', () => {
    expect(parse(lock({ criteria: { c: criterion({ tpr: null }) } })).ok).toBe(false);
  });

  test('rejects a datasetHash that is not a sha256 hex digest', () => {
    expect(parse(lock({ datasetHash: 'abc' })).ok).toBe(false);
  });

  test('accepts an empty criteria record', () => {
    expect(parse(lock({ criteria: {} })).ok).toBe(true);
  });

  test('accepts a threshold on an uncalibrated criterion', () => {
    const c = criterion({ status: 'uncalibrated', threshold: 0.7, reasons: ['too_few_labels'] });
    expect(parse(lock({ criteria: { c } })).ok).toBe(true);
  });

  test('accepts tolerance 0', () => {
    expect(parse(lock({ criteria: { c: criterion({ tolerance: 0 }) } })).ok).toBe(true);
  });

  test('accepts a model without releaseDate', () => {
    const model = { requested: 'jev-1.13.0', resolved: 'jev-1.13.0', transport: 't', pinned: true };
    expect(parse(lock({ model })).ok).toBe(true);
  });

  test('accepts a floating criterion with optional metrics omitted', () => {
    const {
      threshold: _t,
      tpr: _p,
      tnr: _n,
      ece: _e,
      tolerance: _o,
      languages: _l,
      ...c
    } = criterion({ status: 'floating' });
    expect(parse(lock({ criteria: { c } })).ok).toBe(true);
  });

  test('lockSchema deep-equals schemas/lock.schema.json', () => {
    const raw = readFileSync(join(SCHEMAS_DIR, 'lock.schema.json'), 'utf8');
    const file = safeParseJson<unknown>(raw, {});
    expect(file.ok).toBe(true);
    if (file.ok) expect(lockSchema).toEqual(file.value);
  });
});

type ExpectedReason =
  | 'too_few_labels'
  | 'single_class'
  | 'single_class_heldout'
  | 'class_too_small'
  | 'unstable'
  | 'language_limited'
  | 'score_not_gateable'
  | 'reference_missing'
  | 'judge_unavailable'
  | 'paraphrase'
  | 'polarity'
  | 'injection'
  | 'master_key'
  | 'label_permutation'
  | 'constant_output'
  | 'position_swap'
  | 'length';

type ExpectedGauntletKey =
  | 'paraphrase'
  | 'polarity'
  | 'injection'
  | 'master_key'
  | 'label_permutation'
  | 'constant_output'
  | 'position_swap'
  | 'length';

describe('Lock type', () => {
  test('lockVersion is the literal 1 and datasetHash is a string', () => {
    expectTypeOf<Lock['lockVersion']>().toEqualTypeOf<1>();
    expectTypeOf<Lock['datasetHash']>().toEqualTypeOf<string>();
  });

  test('model is {requested, resolved, transport, pinned, releaseDate?}', () => {
    expectTypeOf<Lock['model']>().toEqualTypeOf<LockModel>();
    expectTypeOf<LockModel>().toEqualTypeOf<{
      requested: string;
      resolved: string;
      transport: string;
      pinned: boolean;
      releaseDate?: string;
    }>();
  });

  test('criteria is a typed record of LockCriterion, not Record<string, unknown>', () => {
    expectTypeOf<Lock['criteria'][string]>().toEqualTypeOf<LockCriterion>();
    expectTypeOf<Lock['criteria']>().not.toEqualTypeOf<Record<string, unknown>>();
  });

  test('criterion status, gauntlet and reasons are the exact closed unions', () => {
    expectTypeOf<LockCriterion['status']>().toEqualTypeOf<
      'calibrated' | 'uncalibrated' | 'floating'
    >();
    expectTypeOf<LockCriterion['gauntlet']>().toEqualTypeOf<GauntletResult>();
    expectTypeOf<GauntletResult>().toEqualTypeOf<
      Record<ExpectedGauntletKey, 'pass' | 'fail' | 'skipped'>
    >();
    expectTypeOf<LockReason>().toEqualTypeOf<ExpectedReason>();
    expectTypeOf<LockCriterion['reasons']>().toEqualTypeOf<ExpectedReason[]>();
  });

  test('wordingHash and labelCount are required; metrics and languages are optional', () => {
    expectTypeOf<LockCriterion['wordingHash']>().toEqualTypeOf<string>();
    expectTypeOf<LockCriterion['labelCount']>().toEqualTypeOf<number>();
    expectTypeOf<LockCriterion['threshold']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<LockCriterion['tpr']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<LockCriterion['tnr']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<LockCriterion['ece']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<LockCriterion['tolerance']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<LockCriterion['languages']>().toEqualTypeOf<string[] | undefined>();
    expectTypeOf<LockCriterion['unscored']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<LockCriterion['unscoredCauses']>().toEqualTypeOf<string[] | undefined>();
  });
});
