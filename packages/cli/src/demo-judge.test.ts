import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runEvals } from '@vetkit/core';
import type { JudgeV1 } from '@vetkit/spec';
import { describe, expect, test } from 'vitest';
import { DEMO_TRANSPORT, demoJudge, isDemoJudge } from './demo-judge.ts';

const templatesDir = fileURLToPath(new URL('../templates', import.meta.url));

const questions = {
  b: { type: 'boolean' as const, instructions: 'Is it polite?' },
  c: {
    type: 'choice' as const,
    instructions: 'Which?',
    criteria: { alpha: 'first', beta: 'second', gamma: 'third' },
  },
  s: { type: 'score' as const, instructions: 'How good?', criteria: ['bad', 'ok', 'good'] },
};

describe('demoJudge', () => {
  test('capabilities mark the judge: transport demo, model demo, pinned false, all three question types', () => {
    expect(DEMO_TRANSPORT).toBe('demo');
    expect(demoJudge.capabilities.transport).toBe('demo');
    expect(demoJudge.capabilities.model).toBe('demo');
    expect(demoJudge.capabilities.pinned).toBe(false);
    expect(demoJudge.capabilities.questionTypes).toEqual(
      expect.arrayContaining(['boolean', 'choice', 'score']),
    );
  });

  test('a boolean question answers choice-shaped yes at 0.9 with escape 0', async () => {
    const { answers } = await demoJudge.doJudge({ state: 's', questions: { b: questions.b } });
    expect(answers['b']).toEqual({
      type: 'choice',
      choice: 'yes',
      confidence: 0.9,
      probabilities: { yes: 0.9, no: 0.1, escape: 0 },
    });
  });

  test('a choice question answers the first criteria key at 0.9 and splits 0.1 over the rest', async () => {
    const { answers } = await demoJudge.doJudge({ state: 's', questions: { c: questions.c } });
    const answer = answers['c'];
    expect(answer).toMatchObject({ type: 'choice', choice: 'alpha', confidence: 0.9 });
    if (answer?.type !== 'choice') throw new Error('expected choice');
    expect(answer.probabilities['alpha']).toBe(0.9);
    expect(answer.probabilities['beta']).toBeCloseTo(0.05);
    expect(answer.probabilities['gamma']).toBeCloseTo(0.05);
  });

  test('a score question answers the middle level at 0.9', async () => {
    const { answers } = await demoJudge.doJudge({ state: 's', questions: { s: questions.s } });
    const answer = answers['s'];
    expect(answer).toMatchObject({ type: 'score', score: 1, confidence: 0.9 });
    if (answer?.type !== 'score') throw new Error('expected score');
    expect(answer.probabilities['1']).toBe(0.9);
  });

  test('the same request returns deep-equal answers on two calls', async () => {
    const first = await demoJudge.doJudge({ state: 's', questions });
    const second = await demoJudge.doJudge({ state: 's', questions });
    expect(second).toEqual(first);
  });

  test('response model is {requested: demo, resolved: demo, transport: demo, pinned: false} and usage is zero', async () => {
    const response = await demoJudge.doJudge({ state: 's', questions });
    expect(response.model).toEqual({
      requested: 'demo',
      resolved: 'demo',
      transport: 'demo',
      pinned: false,
    });
    expect(response.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  test('an aborted signal rejects with an AbortError and never resolves', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      demoJudge.doJudge({ state: 's', questions, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('doJudge never calls fetch', async () => {
    // vitest.setup.ts replaces fetch with a guard that throws; a call would reject here.
    await expect(demoJudge.doJudge({ state: 's', questions })).resolves.toBeDefined();
  });

  test('runEvals over the shipped templates with demoJudge exits 0 with 3 passed', async () => {
    const dir = (name: string): string => `${templatesDir}/${name}`;
    expect(readFileSync(dir('criteria.yaml'), 'utf8')).toContain('refund-issued');
    const result = await runEvals({
      config: {
        criteriaPath: dir('criteria.yaml'),
        casesDir: templatesDir,
        judge: demoJudge,
        threshold: 0.5,
      },
      lock: null,
    });
    expect(result.exitCode).toBe(0);
    expect(result.summary).toMatchObject({ total: 3, passed: 3 });
  });

  test('isDemoJudge is true only for transport demo', () => {
    const fake: JudgeV1 = {
      ...demoJudge,
      capabilities: { ...demoJudge.capabilities, transport: 'fake' },
    };
    expect(isDemoJudge(demoJudge)).toBe(true);
    expect(isDemoJudge(fake)).toBe(false);
  });
});
