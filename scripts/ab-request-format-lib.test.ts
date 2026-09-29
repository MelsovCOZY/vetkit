import type { Case, Criterion, Verdict } from '@vetkit/spec';
import { describe, expect, it } from 'vitest';
import { classifyVerdict, tally, type Job, type Outcome } from './ab-request-format-lib.ts';

const evalCase = { id: 'c1' } as Case;
const job = (over: Partial<Job>): Job => ({
  arm: 'raw',
  kind: 'fail-original',
  baseId: 'c1',
  repeat: 0,
  evalCase,
  ...over,
});

describe('tally pairing', () => {
  it('pairs an injected verdict with its failed original', () => {
    const outcomes: Outcome[] = [
      { job: job({}), status: 'fail' },
      { job: job({ kind: 'injected', family: 'encoding' }), status: 'pass' },
      { job: job({ kind: 'injected', family: 'fake_instruction_output' }), status: 'fail' },
    ];
    const r = tally('raw', outcomes);
    expect(r.families['encoding']).toMatchObject({ flips: 1, n: 1 });
    expect(r.families['fake_instruction_output']).toMatchObject({ flips: 0, n: 1 });
  });

  it('does not pair across repeats or arms', () => {
    const outcomes: Outcome[] = [
      { job: job({ repeat: 0 }), status: 'fail' },
      { job: job({ kind: 'injected', family: 'encoding', repeat: 1 }), status: 'pass' },
    ];
    expect(tally('raw', outcomes).families['encoding']?.n).toBe(0);
  });
});

describe('classifyVerdict', () => {
  const criterion = {
    id: 'answer_correct',
    type: 'boolean',
    polarity: 'pass_when_true',
    escape: 'unreadable',
  } as unknown as Criterion;
  const verdict = (p: number): Verdict =>
    ({
      caseId: 'c1',
      criterionId: 'answer_correct',
      status: 'ok',
      answer: { type: 'boolean', probability: p, probabilities: {} },
    }) as unknown as Verdict;

  it('derives pass from the answer probability, not a pass field the judge never sets', () => {
    expect(classifyVerdict(verdict(0.9), criterion).status).toBe('pass');
    expect(classifyVerdict(verdict(0.1), criterion).status).toBe('fail');
  });

  it('marks a missing verdict unscored', () => {
    expect(classifyVerdict(undefined, criterion).status).toBe('unscored');
  });
});
