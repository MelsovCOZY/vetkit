import { describe, expect, test, vi } from 'vitest';
import type { Answer, Criterion, JudgeResponse, JudgeV1 } from '@vetkit/spec';
import { vetMatchers } from './matcher.ts';
import type { ToPassCriterionOptions } from './matcher.ts';

// Type-only augmentation so `expect(x).toPassCriterion(...)` typechecks in this test file;
// vetMatchers()'s return shape (Record<string, matcher fn>) is the real, exported contract —
// this augmentation is test-local ergonomics for the `expect.extend` integration test only.
declare module 'vitest' {
  interface Assertion<T = unknown> {
    toPassCriterion(criterion: Criterion, options?: ToPassCriterionOptions): Promise<void>;
  }
}

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
    doJudge: vi.fn(impl),
  };
}

describe('vetMatchers', () => {
  test('expect.extend registers toPassCriterion and it passes for a passing criterion', async () => {
    const judge = fakeJudge(() =>
      Promise.resolve(response({ [booleanCriterion.id]: { type: 'boolean', probability: 0.9 } })),
    );
    expect.extend(vetMatchers({ judge }));
    await expect('a clear answer').toPassCriterion(booleanCriterion, {
      input: 'What is the capital?',
    });
  });

  test('failure message names the probability, threshold and resolved model', async () => {
    const judge = fakeJudge(() =>
      Promise.resolve(response({ [booleanCriterion.id]: { type: 'boolean', probability: 0.1 } })),
    );
    const matchers = vetMatchers({ judge });
    const result = await matchers.toPassCriterion('an unrelated ramble', booleanCriterion, {
      input: 'question',
    });
    expect(result.pass).toBe(false);
    const message = result.message();
    expect(message).toContain('probability=0.1');
    expect(message).toContain('threshold=0.5');
    expect(message).toContain('jev-1.0.0');
  });

  test('missing input falls back to the output as state, with a warning in the message', async () => {
    const doJudge = vi.fn<JudgeV1['doJudge']>(() =>
      Promise.resolve(response({ [booleanCriterion.id]: { type: 'boolean', probability: 0.9 } })),
    );
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
    const matchers = vetMatchers({ judge });
    const result = await matchers.toPassCriterion('the output text', booleanCriterion);
    expect(doJudge.mock.calls[0]?.[0]).toMatchObject({ state: 'the output text' });
    expect(result.message()).toContain('no input provided');
  });
});
