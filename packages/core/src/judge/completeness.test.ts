// statusForTrace / partitionCases tests (bead mol-pij.7): 3 non-ok statuses, priority order, and
// a contentDependent:false criterion still judged on an excluded case.

import { describe, expect, test } from 'vitest';
import type { Case, Criterion, NormalizedTrace } from '@vetkit/spec';
import { partitionCases, statusForTrace, type CriterionWithFlag } from './completeness.ts';

function completeness(
  overrides: Partial<NormalizedTrace['completeness']> = {},
): NormalizedTrace['completeness'] {
  return { contentCaptured: true, truncated: false, missingParents: false, ...overrides };
}

function makeCase(id: string, provenance: unknown): Case {
  return { id, input: { state: 'state' }, provenance, tags: [] };
}

function criterion(id: string, contentDependent?: boolean): CriterionWithFlag {
  const base: Criterion = {
    id,
    type: 'boolean',
    instructions: 'x',
    escape: 'skip',
    polarity: 'pass_when_true',
    channel: 'quality',
    provenance: { traceIds: [] },
    wordingHash: 'hash',
  };
  return contentDependent === undefined ? base : { ...base, contentDependent };
}

describe('statusForTrace', () => {
  test('ok when captured, not truncated, no missing parents', () => {
    expect(statusForTrace({ completeness: completeness() })).toBe('ok');
  });

  test('content_not_captured takes priority over truncated', () => {
    const status = statusForTrace({
      completeness: completeness({ contentCaptured: false, truncated: true }),
    });
    expect(status).toBe('content_not_captured');
  });

  test('truncated takes priority over incomplete_trace', () => {
    const status = statusForTrace({
      completeness: completeness({ truncated: true, missingParents: true }),
    });
    expect(status).toBe('truncated');
  });

  test('incomplete_trace when only missingParents is set', () => {
    const status = statusForTrace({ completeness: completeness({ missingParents: true }) });
    expect(status).toBe('incomplete_trace');
  });

  test('ok when completeness is absent', () => {
    expect(statusForTrace({})).toBe('ok');
  });
});

describe('partitionCases', () => {
  test('an ok case is judgeable against every criterion', () => {
    const okCase = makeCase('c1', { trace: { completeness: completeness() } });
    const criteria = [criterion('crit1'), criterion('crit2', false)];

    const { judgeable, excluded } = partitionCases([okCase], criteria);

    expect(judgeable).toEqual([{ case: okCase, criteria }]);
    expect(excluded).toEqual([]);
  });

  test('a non-ok case is excluded and only its contentDependent:false criteria stay judgeable', () => {
    const badCase = makeCase('c2', {
      trace: { completeness: completeness({ contentCaptured: false }) },
    });
    const latency = criterion('latency', false);
    const relevance = criterion('relevance');

    const { judgeable, excluded } = partitionCases([badCase], [relevance, latency]);

    expect(judgeable).toEqual([{ case: badCase, criteria: [latency] }]);
    expect(excluded).toEqual([{ case: badCase, status: 'content_not_captured' }]);
  });

  test('a non-ok case with no contentDependent:false criteria is omitted from judgeable', () => {
    const badCase = makeCase('c3', { trace: { completeness: completeness({ truncated: true }) } });
    const relevance = criterion('relevance');

    const { judgeable, excluded } = partitionCases([badCase], [relevance]);

    expect(judgeable).toEqual([]);
    expect(excluded).toEqual([{ case: badCase, status: 'truncated' }]);
  });

  test('never throws on malformed or absent provenance', () => {
    const cases = [
      makeCase('c4', undefined),
      makeCase('c5', null),
      makeCase('c6', 'garbage'),
      makeCase('c7', {}),
      makeCase('c8', { trace: {} }),
      makeCase('c9', { trace: { completeness: 'nonsense' } }),
    ];
    const criteria = [criterion('crit1')];

    expect(() => partitionCases(cases, criteria)).not.toThrow();
    const { judgeable, excluded } = partitionCases(cases, criteria);
    expect(judgeable).toEqual(cases.map((c) => ({ case: c, criteria })));
    expect(excluded).toEqual([]);
  });
});
