import { describe, expect, test } from 'vitest';
import type { Answer, Criterion, JudgeResponse, JudgeV1 } from '@vetkit/spec';
import { vetMatchers } from './matcher.ts';

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
    doJudge: impl,
  };
}

// vitest 5.0.2 ships two mutually-inconsistent `Assertion<...>` type-parameter declarations
// across its own chunks (config.d.CU_b-wJj.d.ts vs task-utils.d.BZm4GSQD.d.ts); resolving
// `ExpectStatic.extend`'s parameter type hits that conflict under this repo's
// skipLibCheck:false tsconfig regardless of the argument's own type. The casts below (through
// `never` at the extend call, and through a narrow local interface at the fluent call) route
// around resolving vitest's own broken merge rather than around anything in this package.
interface FluentToPassCriterion {
  toPassCriterion(criterion: Criterion): Promise<void>;
}

describe('vetMatchers', () => {
  test('expect.extend really registers toPassCriterion on expect(...)', async () => {
    const passJudge = fakeJudge(() =>
      Promise.resolve(response({ [booleanCriterion.id]: { type: 'boolean', probability: 0.9 } })),
    );
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- vitest 5.0.2 Assertion<...> d.ts chunk conflict (see block comment above), not a gap in this package.
    expect.extend(vetMatchers({ judge: passJudge }) as never);
    await expect(
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- same vitest 5.0.2 conflict.
      (expect('a clear answer') as unknown as FluentToPassCriterion).toPassCriterion(
        booleanCriterion,
      ),
    ).resolves.toBeUndefined();

    const failJudge = fakeJudge(() =>
      Promise.resolve(response({ [booleanCriterion.id]: { type: 'boolean', probability: 0.1 } })),
    );
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- same vitest 5.0.2 conflict.
    expect.extend(vetMatchers({ judge: failJudge }) as never);
    await expect(
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- same vitest 5.0.2 conflict.
      (expect('an unrelated ramble') as unknown as FluentToPassCriterion).toPassCriterion(
        booleanCriterion,
      ),
    ).rejects.toThrow(/probability=0\.1.*threshold=0\.5.*jev-1\.0\.0/s);
  });

  test('direct matchers.toPassCriterion call passes for a passing criterion', async () => {
    const judge = fakeJudge(() =>
      Promise.resolve(response({ [booleanCriterion.id]: { type: 'boolean', probability: 0.9 } })),
    );
    const matchers = vetMatchers({ judge });
    const result = await matchers.toPassCriterion('a clear answer', booleanCriterion, {
      input: 'What is the capital?',
    });
    expect(result.pass).toBe(true);
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
    let lastRequestState: string | undefined;
    const doJudge: JudgeV1['doJudge'] = (req) => {
      lastRequestState = req.state;
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
    const matchers = vetMatchers({ judge });
    const result = await matchers.toPassCriterion('the output text', booleanCriterion);
    expect(lastRequestState).toBe('the output text');
    expect(result.message()).toContain('no input provided');
  });
});
