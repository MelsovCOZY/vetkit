import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCriteria } from '@vetkit/core';
import type { Case, Verdict } from '@vetkit/spec';
import { describe, expect, it } from 'vitest';
import { classifyVerdict, tally, type Job, type Outcome } from './ab-request-format-lib.ts';

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

const model = { requested: 'm', resolved: 'm', transport: 't', pinned: false };
const verdictWith = (p: number): Verdict => ({
  caseId: 'c1',
  criterionId: 'answer_correct',
  status: 'ok',
  answer: { type: 'boolean', probability: p },
  model,
  cacheHit: false,
});

describe('classifyVerdict', () => {
  it('derives pass from the answer probability, not a pass field the judge never sets', async () => {
    const criteria = await loadCriteria(join(PROJECT, 'evals/criteria.yaml'));
    if (!criteria.ok) throw new Error('cannot load fixture criteria');
    const criterion = criteria.criteria.find((c) => c.id === 'answer_correct');
    if (criterion === undefined) throw new Error('missing criterion');
    expect(classifyVerdict(verdictWith(0.9), criterion).status).toBe('pass');
    expect(classifyVerdict(verdictWith(0.1), criterion).status).toBe('fail');
    expect(classifyVerdict(undefined, criterion).status).toBe('unscored');
  });
});
