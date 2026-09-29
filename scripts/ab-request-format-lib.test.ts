import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCriteria } from '@vetkit/core';
import type { Case, Criterion, Verdict } from '@vetkit/spec';
import { describe, expect, it } from 'vitest';
import {
  classifyVerdict,
  tally,
  withPass,
  type Job,
  type Outcome,
} from './ab-request-format-lib.ts';

const PROJECT = fileURLToPath(new URL('../fixtures/projects/j3', import.meta.url));
const evalCase: Case = { id: 'c1', input: { state: 's' }, provenance: null, tags: [] };
const job = (over: Partial<Job>): Job => ({
  arm: 'raw',
  kind: 'fail-original',
  baseId: 'c1',
  repeat: 0,
  evalCase,
  ...over,
});

const model = { requested: 'm', resolved: 'm', transport: 't', pinned: false };
const verdictWith = (p: number, pass?: boolean, status: Verdict['status'] = 'ok'): Verdict => ({
  caseId: 'c1',
  criterionId: 'answer_correct',
  status,
  answer: { type: 'boolean', probability: p },
  ...(pass === undefined ? {} : { pass }),
  model,
  cacheHit: false,
});
const outcome = (j: Job, p: number, pass: boolean, status: Verdict['status'] = 'ok'): Outcome => ({
  job: j,
  status: status === 'ok' ? (pass ? 'pass' : 'fail') : 'unscored',
  verdict: verdictWith(p, pass, status),
});

describe('tally pairing', () => {
  it('pairs an injected outcome with its original and applies the gauntlet trial rule', async () => {
    const criterion = await answerCorrect();
    const outcomes: Outcome[] = [
      outcome(job({}), 0.1, false),
      outcome(job({ kind: 'injected', family: 'encoding' }), 0.5, false),
      outcome(job({ kind: 'injected', family: 'fake_instruction_output' }), 0.2, false),
    ];
    const r = tally('raw', outcomes, criterion);
    expect(r.families['encoding']).toMatchObject({
      trials: 1,
      failed: 1,
      flips: 0,
      broken: 0,
      overMax: 1,
    });
    expect(r.families['fake_instruction_output']).toMatchObject({
      trials: 1,
      failed: 0,
      overMax: 0,
    });
    expect(r.families['encoding']?.maxDelta).toBeCloseTo(0.4);
    expect(r.trials).toContainEqual({
      arm: 'raw',
      family: 'encoding',
      caseId: 'c1',
      repeat: 0,
      pOrig: 0.1,
      pInj: 0.5,
      delta: expect.closeTo(0.4),
      failed: true,
    });
  });

  it('injects known-pass cases too and counts a broken injected verdict', async () => {
    const criterion = await answerCorrect();
    const outcomes: Outcome[] = [
      outcome(job({ kind: 'pass-original' }), 0.9, true),
      outcome(job({ kind: 'injected', family: 'encoding' }), 0.9, true, 'unscored'),
    ];
    expect(tally('raw', outcomes, criterion).families['encoding']).toMatchObject({
      trials: 1,
      failed: 1,
      broken: 1,
    });
  });

  it('does not pair across repeats or arms', async () => {
    const criterion = await answerCorrect();
    const outcomes: Outcome[] = [
      outcome(job({ repeat: 0 }), 0.1, false),
      outcome(job({ kind: 'injected', family: 'encoding', repeat: 1 }), 0.9, true),
      outcome(job({ kind: 'injected', family: 'encoding', arm: 'fenced-v1' }), 0.9, true),
    ];
    expect(tally('raw', outcomes, criterion).families['encoding']?.trials).toBe(0);
  });
});

async function answerCorrect(): Promise<Criterion> {
  const criteria = await loadCriteria(join(PROJECT, 'evals/criteria.yaml'));
  if (!criteria.ok) throw new Error('cannot load fixture criteria');
  const criterion = criteria.criteria.find((c) => c.id === 'answer_correct');
  if (criterion === undefined) throw new Error('missing criterion');
  return criterion;
}

describe('classifyVerdict', () => {
  it('derives pass from the answer probability, not a pass field the judge never sets', async () => {
    const criterion = await answerCorrect();
    expect(classifyVerdict(verdictWith(0.9), criterion).status).toBe('pass');
    expect(classifyVerdict(verdictWith(0.1), criterion).status).toBe('fail');
  });

  it('marks a missing verdict unscored', async () => {
    expect(classifyVerdict(undefined, await answerCorrect()).status).toBe('unscored');
  });

  it('withPass sets the pass flag the gauntlet trial rule reads', async () => {
    const criterion = await answerCorrect();
    expect(withPass(verdictWith(0.9), criterion).pass).toBe(true);
    expect(withPass(verdictWith(0.1), criterion).pass).toBe(false);
  });
});
