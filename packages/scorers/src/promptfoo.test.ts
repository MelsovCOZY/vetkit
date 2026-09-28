import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import type { Answer, Criterion, JudgeResponse, JudgeV1 } from '@vetkit/spec';
import { toPromptfooAssertion } from './promptfoo.ts';

// Read (not import) the fixture: a static cross-boundary type import from src/ into fixtures/
// breaks scripts/tsconfig.test.ts's isolated-workspace typecheck copy, which copies only each
// package's package.json/tsconfig.json/src (never fixtures/) — see that file's
// createIsolatedWorkspace(). A plain fs read at test-run time has no such compile-time
// dependency, so it asserts the same "shape matches the fixture" property without it.
const FIXTURE_PATH = fileURLToPath(
  new URL('../fixtures/promptfoo-grading-result.d.ts', import.meta.url),
);

function fixtureFieldNames(): string[] {
  const text = readFileSync(FIXTURE_PATH, 'utf8');
  return [...text.matchAll(/^\s*(\w+)\??:/gm)]
    .map((m) => m[1])
    .filter((name): name is string => name !== undefined);
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
    doJudge: impl,
  };
}

describe('toPromptfooAssertion', () => {
  test('shape matches the promptfoo GradingResult fixture on a pass', async () => {
    const judge = fakeJudge(() =>
      Promise.resolve(response({ [booleanCriterion.id]: { type: 'boolean', probability: 0.9 } })),
    );
    const assertion = toPromptfooAssertion({ judge, criterion: booleanCriterion });
    const result = await assertion('a clear answer');
    expect(result.pass).toBe(true);
    expect(typeof result.score).toBe('number');
    expect(typeof result.reason).toBe('string');
    expect(result.namedScores?.[booleanCriterion.id]).toBeCloseTo(0.9);
    expect(result.metadata?.model).toBeDefined();
    expect(result.graderError).not.toBe(true);
    const fixtureFields = fixtureFieldNames();
    for (const key of Object.keys(result)) {
      expect(fixtureFields).toContain(key);
    }
  });

  test('graderError:true only for a transport failure', async () => {
    const judge = fakeJudge(() => Promise.reject(new Error('network down')));
    const assertion = toPromptfooAssertion({ judge, criterion: booleanCriterion });
    const result = await assertion('anything');
    expect(result.graderError).toBe(true);
    expect(result.pass).toBe(false);
  });

  test('escape maps to pass:true, score:0, reason names the criterion, no graderError', async () => {
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
    const assertion = toPromptfooAssertion({ judge, criterion: booleanCriterion });
    const result = await assertion('');
    expect(result).toMatchObject({
      pass: true,
      score: 0,
      reason: `${booleanCriterion.id} escaped: not_applicable`,
      metadata: { status: 'not_applicable' },
    });
    expect(result.graderError).not.toBe(true);
  });

  test('namedScores is keyed by the criterion id', async () => {
    const judge = fakeJudge(() =>
      Promise.resolve(response({ [booleanCriterion.id]: { type: 'boolean', probability: 0.7 } })),
    );
    const assertion = toPromptfooAssertion({ judge, criterion: booleanCriterion });
    const result = await assertion('ok');
    expect(Object.keys(result.namedScores ?? {})).toEqual([booleanCriterion.id]);
  });
});
