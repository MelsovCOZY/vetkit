import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import type { Answer, Criterion, JudgeResponse, JudgeV1, Lock } from '@vetkit/spec';
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

function lockFor(id: string, status: 'calibrated', threshold: number): Lock {
  const pass = 'pass' as const;
  return {
    lockVersion: 1,
    model: { requested: 'jev-fake-model', resolved: 'jev-1.0.0', transport: 'fake', pinned: false },
    datasetHash: 'dataset-hash',
    criteria: {
      [id]: {
        wordingHash: 'hash-a',
        status,
        threshold,
        gauntlet: {
          paraphrase: pass,
          polarity: pass,
          injection: pass,
          master_key: pass,
          label_permutation: pass,
          constant_output: pass,
          position_swap: pass,
          length: pass,
        },
        reasons: [],
        labelCount: 20,
      },
    },
  };
}

describe('toPromptfooAssertion lock', () => {
  test('lock passed in → GradingResult metadata.calibration reads the lock entry', async () => {
    const judge = fakeJudge(() =>
      Promise.resolve(response({ [booleanCriterion.id]: { type: 'boolean', probability: 0.55 } })),
    );
    const lock = lockFor(booleanCriterion.id, 'calibrated', 0.7);
    const result = await toPromptfooAssertion({ judge, criterion: booleanCriterion, lock })('text');
    expect(result.pass).toBe(false);
    expect(result.metadata?.calibration).toBe('calibrated');
  });
});

describe('toPromptfooAssertion context', () => {
  interface Captured {
    state?: string;
    instructions: string[];
  }
  function capturingJudge(captured: Captured): JudgeV1 {
    const base = fakeJudge((req) => {
      captured.state = req.state;
      captured.instructions = Object.values(req.questions).map((q) => q.instructions);
      return Promise.resolve(
        response({ [booleanCriterion.id]: { type: 'boolean', probability: 0.9 } }),
      );
    });
    return { ...base, capabilities: { ...base.capabilities, requestFormat: 'raw' } };
  }

  test('context.vars.input (string) is the judged state; metadata.stateSource = vars', async () => {
    const captured: Captured = { instructions: [] };
    const assertion = toPromptfooAssertion({
      judge: capturingJudge(captured),
      criterion: booleanCriterion,
    });
    const result = await assertion('the model output', {
      prompt: 'the prompt',
      vars: { input: 'the conversation' },
    });
    expect(captured.state).toBe('the conversation');
    expect(result.metadata?.stateSource).toBe('vars');
  });

  test('no vars.input but context.prompt → prompt is the state; stateSource = prompt', async () => {
    const captured: Captured = { instructions: [] };
    const assertion = toPromptfooAssertion({
      judge: capturingJudge(captured),
      criterion: booleanCriterion,
    });
    const result = await assertion('the model output', {
      prompt: 'the prompt text',
      vars: { input: { not: 'a string' } },
    });
    expect(captured.state).toBe('the prompt text');
    expect(result.metadata?.stateSource).toBe('prompt');
  });

  test('no context at all → output alone; stateSource = output', async () => {
    const captured: Captured = { instructions: [] };
    const assertion = toPromptfooAssertion({
      judge: capturingJudge(captured),
      criterion: booleanCriterion,
    });
    const result = await assertion('the model output');
    expect(captured.state).toBe('the model output');
    expect(result.metadata?.stateSource).toBe('output');
    const emptyPrompt = await assertion('the model output', { prompt: '', vars: {} });
    expect(emptyPrompt.metadata?.stateSource).toBe('output');
  });

  test('inputVar / expectedVar options rename the vars read; expected reaches the reference criterion', async () => {
    const captured: Captured = { instructions: [] };
    const referenceCriterion: Criterion = {
      ...booleanCriterion,
      grader: { kind: 'reference' },
    };
    const assertion = toPromptfooAssertion({
      judge: capturingJudge(captured),
      criterion: referenceCriterion,
      inputVar: 'question',
      expectedVar: 'gold',
    });
    const result = await assertion('out', {
      vars: { question: 'renamed input', input: 'ignored', gold: 'forty-two' },
    });
    expect(captured.state).toBe('renamed input');
    expect(result.metadata?.stateSource).toBe('vars');
    expect(captured.instructions.join(' ')).toContain('forty-two');

    const nonString = await assertion('out', { vars: { question: 'q', gold: 42 } });
    expect(nonString.pass).toBe(true);
    expect(captured.instructions.join(' ')).not.toContain('42');
  });

  test('vars and prompt text never appear in reason or metadata', async () => {
    const captured: Captured = { instructions: [] };
    const assertion = toPromptfooAssertion({
      judge: capturingJudge(captured),
      criterion: booleanCriterion,
    });
    const canary = 'CANARY-7f3a-secret-conversation';
    const viaVars = await assertion('out', { prompt: canary, vars: { input: canary } });
    const viaPrompt = await assertion('out', { prompt: canary });
    for (const result of [viaVars, viaPrompt]) {
      expect(JSON.stringify(result.reason)).not.toContain(canary);
      expect(JSON.stringify(result.metadata)).not.toContain(canary);
    }
  });
});
