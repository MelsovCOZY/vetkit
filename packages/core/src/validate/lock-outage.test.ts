import { describe, expect, test } from 'vitest';
import {
  lockSchema,
  safeParseJson,
  type Criterion,
  type GauntletResult,
  type JudgeResponse,
} from '@vetkit/spec';
import { computeWordingHash, type WordingFields } from '../criteria/load.ts';
import type { CalibrationResult } from './calibrate.ts';
import { buildLock, unscoredOf } from './lock.ts';

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

const MODEL: JudgeResponse['model'] = {
  requested: 'judge-a',
  resolved: 'judge-a-2026',
  transport: 'transport-a',
  pinned: true,
  provider: 'someone',
  credentialType: 'key',
};

const CRITERION: Criterion = (() => {
  const base = {
    id: 'answers-question',
    type: 'boolean',
    instructions: 'Does the reply answer the question?',
    escape: 'The reply is empty.',
    polarity: 'pass_when_true',
    channel: 'outcome',
    provenance: { traceIds: [] },
  } as const;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const c = base as unknown as Criterion;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return { ...c, wordingHash: computeWordingHash(c as unknown as WordingFields) };
})();

const CALIBRATION: CalibrationResult = {
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
  status: 'uncalibrated',
  reasons: ['class_too_small', 'unstable'],
  labelCount: 120,
};

interface FakeVerdict {
  readonly criterionId: string;
  readonly status: string;
  readonly cause?: unknown;
}

/** Fake judge outcomes: `failed` of `total` verdicts are unscored. */
function verdicts(total: number, failed: number, criterionId = CRITERION.id): FakeVerdict[] {
  return Array.from({ length: total }, (_, i) =>
    i < failed
      ? { criterionId, status: 'unscored', cause: { code: 'JUDGE_TIMEOUT', body: 'SECRET' } }
      : { criterionId, status: 'ok' },
  );
}

function lockFor(vs: readonly FakeVerdict[]) {
  const lock = buildLock({
    model: MODEL,
    criteria: [CRITERION],
    cases: [],
    results: {
      [CRITERION.id]: {
        calibration: CALIBRATION,
        gauntlet: ALL_PASS,
        unscored: unscoredOf(CRITERION.id, vs),
      },
    },
  });
  const entry = lock.criteria[CRITERION.id];
  if (entry === undefined) throw new Error('no entry');
  return { lock, entry };
}

describe('unscoredOf', () => {
  test('counts only this criterion, codes only, sorted and deduped', () => {
    const u = unscoredOf('a', [
      { criterionId: 'a', status: 'unscored', cause: { code: 'Z', detail: 'x' } },
      { criterionId: 'a', status: 'unscored', cause: 'A' },
      { criterionId: 'a', status: 'unscored', cause: 'A' },
      { criterionId: 'a', status: 'ok' },
      { criterionId: 'b', status: 'unscored', cause: 'B' },
    ]);
    expect(u).toEqual({ count: 3, total: 4, causes: ['A', 'Z'] });
  });
});

describe('buildLock under judge outage', () => {
  test('90% outage: judge_unavailable replaces data-shape reasons, records unscored', () => {
    const { lock, entry } = lockFor(verdicts(10, 9));
    expect(entry.status).toBe('uncalibrated');
    expect(entry.reasons).toEqual(['judge_unavailable']);
    expect(entry.unscored).toBe(9);
    expect(entry.unscoredCauses).toEqual(['JUDGE_TIMEOUT']);
    expect(JSON.stringify(lock)).not.toContain('SECRET');
    expect(safeParseJson(JSON.stringify(lock), lockSchema).ok).toBe(true);
  });

  test('exactly 10% unscored is not an outage', () => {
    const { entry } = lockFor(verdicts(10, 1));
    expect(entry.reasons).not.toContain('judge_unavailable');
  });

  test('full-scoring run has neither judge_unavailable nor unscored', () => {
    const { entry } = lockFor(verdicts(10, 0));
    expect(entry.reasons).not.toContain('judge_unavailable');
    expect(entry).not.toHaveProperty('unscored');
    expect(entry).not.toHaveProperty('unscoredCauses');
  });

  test('an old lock without the new fields still parses', () => {
    const { lock } = lockFor(verdicts(10, 0));
    expect(safeParseJson(JSON.stringify(lock), lockSchema).ok).toBe(true);
  });

  test('unscoredCauses must be strings', () => {
    const { lock, entry } = lockFor(verdicts(10, 9));
    const bad = { ...lock, criteria: { [CRITERION.id]: { ...entry, unscoredCauses: [1] } } };
    expect(safeParseJson(JSON.stringify(bad), lockSchema).ok).toBe(false);
  });
});
