import { describe, expect, test } from 'vitest';
import type { CachedJudgment, VerdictCache } from '@vetkit/core';
import type { Answer, Criterion, JudgeResponse, JudgeV1 } from '@vetkit/spec';
import { createScorer } from './scorer.ts';

const booleanCriterion: Criterion = {
  id: 'answers-question',
  type: 'boolean',
  instructions: "Does the reply directly answer the user's question?",
  escape: 'The reply is empty or not in a readable language.',
  polarity: 'pass_when_true',
  channel: 'outcome',
  provenance: { traceIds: [] },
  wordingHash: 'hash-a',
};

const scoreCriterion: Criterion = {
  id: 'helpfulness',
  type: 'score',
  instructions: 'How helpful is the reply?',
  criteria: ['not helpful', 'somewhat helpful', 'very helpful'],
  polarity: 'pass_when_true',
  channel: 'quality',
  provenance: { traceIds: [] },
  wordingHash: 'hash-c',
};

function response(answers: Record<string, Answer>): JudgeResponse {
  return {
    answers,
    usage: { inputTokens: 10, outputTokens: 0 },
    model: {
      requested: 'jev-fake-model',
      resolved: 'jev-1.0.0',
      transport: 'fake',
      pinned: false,
    },
  };
}

function fakeJudge(impl: JudgeV1['doJudge']): JudgeV1 {
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
    doJudge: impl,
  };
}

describe('createScorer', () => {
  test('pass -> score 1', async () => {
    const judge = fakeJudge(() =>
      Promise.resolve(response({ [booleanCriterion.id]: { type: 'boolean', probability: 0.9 } })),
    );
    const score = createScorer({ judge, criterion: booleanCriterion });
    const result = await score({ output: 'a clear answer' });
    expect(result.score).toBe(1);
    expect(result.name).toBe('answers-question');
    expect(result.metadata.status).toBe('ok');
  });

  test('fail -> score 0', async () => {
    const judge = fakeJudge(() =>
      Promise.resolve(response({ [booleanCriterion.id]: { type: 'boolean', probability: 0.1 } })),
    );
    const score = createScorer({ judge, criterion: booleanCriterion });
    const result = await score({ output: 'an unrelated ramble' });
    expect(result.score).toBe(0);
  });

  test('escape -> score null (never 0), status not_applicable', async () => {
    const judge = fakeJudge(() =>
      Promise.resolve(
        response({
          [booleanCriterion.id]: {
            type: 'choice',
            choice: 'escape',
            confidence: 0.95,
            probabilities: { escape: 0.95 },
          },
        }),
      ),
    );
    const score = createScorer({ judge, criterion: booleanCriterion });
    const result = await score({ output: '' });
    expect(result.score).toBeNull();
    expect(result.metadata.status).toBe('not_applicable');
  });

  test('transport error -> score null, status unscored', async () => {
    const judge = fakeJudge(() => Promise.reject(new Error('network down')));
    const score = createScorer({ judge, criterion: booleanCriterion });
    const result = await score({ output: 'anything' });
    expect(result.score).toBeNull();
    expect(result.metadata.status).toBe('unscored');
  });

  test('reuses a supplied cache across two calls with the same state', async () => {
    let callCount = 0;
    const doJudge: JudgeV1['doJudge'] = () => {
      callCount += 1;
      return Promise.resolve(
        response({ [booleanCriterion.id]: { type: 'boolean', probability: 0.9 } }),
      );
    };
    const judge: JudgeV1 = {
      specVersion: 'v1',
      id: 'judge-fake',
      capabilities: {
        questionTypes: ['boolean'],
        maxStateTokens: 32_000,
        pinned: false,
        transport: 'fake',
        model: 'jev-fake-model',
      },
      doJudge,
    };
    const store = new Map<string, CachedJudgment>();
    const cache: VerdictCache = {
      get: (key) => Promise.resolve(store.get(key)),
      set: (key, entry) => {
        store.set(key, entry);
        return Promise.resolve();
      },
    };
    const score = createScorer({ judge, criterion: booleanCriterion, cache });
    await score({ output: 'same state' });
    await score({ output: 'same state' });
    expect(callCount).toBe(1);
  });

  test('score criterion passes by threshold band using decideVerdict', async () => {
    const judge = fakeJudge(() =>
      Promise.resolve(
        response({
          [scoreCriterion.id]: {
            type: 'score',
            score: 2,
            confidence: 0.9,
            legend: {},
            probabilities: { '0': 0, '1': 0, '2': 1 },
          },
        }),
      ),
    );
    const score = createScorer({ judge, criterion: scoreCriterion, threshold: 1 });
    const result = await score({ output: 'excellent' });
    expect(result.score).toBe(1);
    expect(result.metadata.probability).toBeCloseTo(2);
  });
});
