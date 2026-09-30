import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import type { Answer, Criterion, JudgeResponse, JudgeV1, Lock, LockCriterion } from '@vetkit/spec';
import { judgeOne } from './judge-one.ts';

const criterion: Criterion = {
  id: 'answers-question',
  type: 'boolean',
  instructions: "Does the reply directly answer the user's question?",
  escape: 'The reply is empty or not in a readable language.',
  polarity: 'pass_when_true',
  channel: 'outcome',
  provenance: { traceIds: [] },
  wordingHash: 'hash-a',
};

function judgeAnswering(probability: number): JudgeV1 {
  const answers: Record<string, Answer> = { [criterion.id]: { type: 'boolean', probability } };
  const response: JudgeResponse = {
    answers,
    usage: { inputTokens: 10, outputTokens: 0 },
    model: { requested: 'jev-fake-model', resolved: 'jev-1.0.0', transport: 'fake', pinned: false },
  };
  return {
    specVersion: 'v1',
    id: 'judge-fake',
    capabilities: {
      questionTypes: ['boolean', 'choice', 'score'],
      maxStateTokens: 32_000,
      pinned: false,
      transport: 'fake',
      model: 'jev-fake-model',
    },
    doJudge: () => Promise.resolve(response),
  };
}

function lockWith(entries: Record<string, Partial<LockCriterion>>): Lock {
  const gauntlet = {
    paraphrase: 'pass',
    polarity: 'pass',
    injection: 'pass',
    master_key: 'pass',
    label_permutation: 'pass',
    constant_output: 'pass',
    position_swap: 'pass',
    length: 'pass',
  } as const;
  return {
    lockVersion: 1,
    model: { requested: 'jev-fake-model', resolved: 'jev-1.0.0', transport: 'fake', pinned: false },
    datasetHash: 'dataset-hash',
    criteria: Object.fromEntries(
      Object.entries(entries).map(([id, entry]) => [
        id,
        {
          wordingHash: 'hash-a',
          status: 'calibrated',
          gauntlet,
          reasons: [],
          labelCount: 20,
          ...entry,
        },
      ]),
    ),
  };
}

describe('judgeOne lock resolution', () => {
  test('no lock → threshold 0.5, tolerance 0, calibration none', async () => {
    const result = await judgeOne({ judge: judgeAnswering(0.55), criterion, state: 's' });
    expect(result.pass).toBe(true);
    expect(result.borderline).toBe(false);
    expect(result.threshold).toBe(0.5);
    expect(result.calibration).toBe('none');
  });

  test('lock entry threshold 0.7 → a 0.55 answer fails; calibration reads the entry status', async () => {
    const lock = lockWith({ [criterion.id]: { threshold: 0.7, status: 'calibrated' } });
    const result = await judgeOne({ judge: judgeAnswering(0.55), criterion, state: 's', lock });
    expect(result.pass).toBe(false);
    expect(result.threshold).toBe(0.7);
    expect(result.calibration).toBe('calibrated');
  });

  test('lock entry tolerance 0.1 → |p − threshold| ≤ 0.1 marks borderline true and pass is decided by sign', async () => {
    const lock = lockWith({ [criterion.id]: { threshold: 0.7, tolerance: 0.1 } });
    const below = await judgeOne({ judge: judgeAnswering(0.65), criterion, state: 's', lock });
    expect(below.borderline).toBe(true);
    expect(below.pass).toBe(false);
    const above = await judgeOne({ judge: judgeAnswering(0.75), criterion, state: 's', lock });
    expect(above.borderline).toBe(true);
    expect(above.pass).toBe(true);
    const clear = await judgeOne({ judge: judgeAnswering(0.95), criterion, state: 's', lock });
    expect(clear.borderline).toBe(false);
  });

  test('explicit threshold option beats the lock entry; calibration still comes from the lock', async () => {
    const lock = lockWith({ [criterion.id]: { threshold: 0.7, status: 'floating' } });
    const result = await judgeOne({
      judge: judgeAnswering(0.55),
      criterion,
      state: 's',
      lock,
      threshold: 0.4,
    });
    expect(result.threshold).toBe(0.4);
    expect(result.pass).toBe(true);
    expect(result.calibration).toBe('floating');
  });

  test('lock without an entry for the criterion → threshold 0.5, calibration none', async () => {
    const lock = lockWith({ 'some-other-criterion': { threshold: 0.9 } });
    const result = await judgeOne({ judge: judgeAnswering(0.55), criterion, state: 's', lock });
    expect(result.threshold).toBe(0.5);
    expect(result.pass).toBe(true);
    expect(result.calibration).toBe('none');
  });

  test('uncalibrated entry without threshold → 0.5 and calibration uncalibrated', async () => {
    const lock = lockWith({ [criterion.id]: { status: 'uncalibrated' } });
    const result = await judgeOne({ judge: judgeAnswering(0.55), criterion, state: 's', lock });
    expect(result.threshold).toBe(0.5);
    expect(result.calibration).toBe('uncalibrated');
  });

  test('escaped and unscored results still carry calibration', async () => {
    const lock = lockWith({ [criterion.id]: { status: 'calibrated' } });
    const failing: JudgeV1 = {
      ...judgeAnswering(0.5),
      doJudge: () => Promise.reject(new Error('network down')),
    };
    const unscored = await judgeOne({ judge: failing, criterion, state: 's', lock });
    expect(unscored.verdict.status).toBe('unscored');
    expect(unscored.calibration).toBe('calibrated');
    const escapeJudge: JudgeV1 = {
      ...judgeAnswering(0.5),
      doJudge: () =>
        Promise.resolve({
          answers: {
            [criterion.id]: {
              type: 'choice',
              choice: 'escape',
              confidence: 0.95,
              probabilities: { escape: 0.95 },
            },
          },
          usage: { inputTokens: 1, outputTokens: 0 },
          model: { requested: 'm', resolved: 'm', transport: 'fake', pinned: false },
        }),
    };
    const escaped = await judgeOne({ judge: escapeJudge, criterion, state: 's' });
    expect(escaped.verdict.status).toBe('not_applicable');
    expect(escaped.calibration).toBe('none');
  });
});

describe('@vetkit/scorers purity', () => {
  test('no fs import anywhere in packages/scorers/src', () => {
    const dir = fileURLToPath(new URL('.', import.meta.url));
    const sources = ['judge-one.ts', 'scorer.ts', 'matcher.ts', 'promptfoo.ts'];
    for (const file of sources) {
      const text = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(text, file).not.toMatch(/['"](node:)?fs(\/promises)?['"]/);
    }
    const production = readdirSync(dir).filter(
      (file) => file.endsWith('.ts') && !/\.test(-d)?\.ts$/.test(file),
    );
    for (const file of production) {
      const text = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(text, file).not.toMatch(/['"](node:)?fs(\/promises)?['"]/);
    }
  });
});
