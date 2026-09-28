import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { safeParseJson, type Case, type Criterion, type JsonSchema } from '@vetkit/spec';
import { gradeCode, referenceRequirement, renderReference } from './reference.ts';

// fixtures/reference/cases.jsonl is read through the safeParseJson chokepoint (packages/spec/
// src/json.ts), same precedent as packages/spec/schemas/ir.test.ts uses plain JSON.parse for
// schemas/docs fixtures: scripts/ban-raw-json-parse.sh bans raw JSON.parse in packages/*/src,
// and this file lives under packages/core/src, so it goes through the chokepoint instead.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const FIXTURE_PATH = join(REPO_ROOT, 'fixtures', 'reference', 'cases.jsonl');

interface FixtureRow {
  readonly id: string;
  readonly check: 'exact' | 'normalized' | 'numeric';
  readonly answer: string;
  readonly expected: unknown;
  readonly pass: boolean;
}

const fixtureRowSchema: JsonSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    check: { enum: ['exact', 'normalized', 'numeric'] },
    answer: { type: 'string' },
    expected: {},
    pass: { type: 'boolean' },
  },
  required: ['id', 'check', 'answer', 'expected', 'pass'],
  additionalProperties: false,
};

function loadFixtureRows(): FixtureRow[] {
  const raw = readFileSync(FIXTURE_PATH, 'utf8');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const result = safeParseJson<FixtureRow>(line, fixtureRowSchema);
      if (!result.ok) throw new Error(`invalid fixture row: ${line}`);
      return result.value;
    });
}

const fixtureRows = loadFixtureRows();

function countByCheck(check: FixtureRow['check']): number {
  return fixtureRows.filter((row) => row.check === check).length;
}

function codeCriterion(check: 'exact' | 'normalized' | 'numeric'): Criterion {
  return {
    id: 'c-code',
    type: 'boolean',
    instructions: 'Does the answer match the reference?',
    escape: 'unsure',
    polarity: 'pass_when_true',
    channel: 'outcome',
    provenance: { traceIds: [] },
    wordingHash: '0'.repeat(64),
    checkable: 'factual',
    grader: { kind: 'code', check },
  };
}

function referenceCriterion(instructions: string): Criterion {
  return {
    id: 'c-ref',
    type: 'boolean',
    instructions,
    escape: 'unsure',
    polarity: 'pass_when_true',
    channel: 'outcome',
    provenance: { traceIds: [] },
    wordingHash: '1'.repeat(64),
    checkable: 'factual',
    grader: { kind: 'reference' },
  };
}

function judgeCriterion(overrides: Partial<Pick<Criterion, 'checkable'>> = {}): Criterion {
  return {
    id: 'c-judge',
    type: 'boolean',
    instructions: 'Is the answer helpful?',
    escape: 'unsure',
    polarity: 'pass_when_true',
    channel: 'quality',
    provenance: { traceIds: [] },
    wordingHash: '2'.repeat(64),
    ...overrides,
  };
}

function makeCase(id: string, answer: string | undefined, expected?: unknown): Case {
  const input: Case['input'] = answer === undefined ? { state: 's' } : { state: 's', answer };
  return expected === undefined
    ? { id, input, provenance: null, tags: [] }
    : { id, input, provenance: null, tags: [], expected: { value: expected, source: 'user' } };
}

describe('renderReference', () => {
  test('returns the reference block appended to the instructions for a reference-graded criterion with expected', () => {
    const criterion = referenceCriterion('Did the assistant answer correctly?');
    const evalCase = makeCase('case-1', 'Paris', '42');

    expect(renderReference(criterion, evalCase)).toBe(
      'Did the assistant answer correctly? Reference answer: 42. Treat the output as correct ' +
        'when it states the same answer; ignore wording, citation markers, language and ' +
        'formatting; numbers are equal when they express the same quantity.',
    );
  });

  test('returns null for a judge-only criterion even when the case has expected', () => {
    const criterion = judgeCriterion();
    const evalCase = makeCase('case-2', 'Paris', '42');

    expect(renderReference(criterion, evalCase)).toBeNull();
  });

  test('returns null for a reference-graded criterion when the case has no expected', () => {
    const criterion = referenceCriterion('Did the assistant answer correctly?');
    const evalCase = makeCase('case-3', 'Paris');

    expect(renderReference(criterion, evalCase)).toBeNull();
  });
});

describe('gradeCode', () => {
  test('the fixture table has at least 4 rows per check', () => {
    expect(countByCheck('exact')).toBeGreaterThanOrEqual(4);
    expect(countByCheck('normalized')).toBeGreaterThanOrEqual(4);
    expect(countByCheck('numeric')).toBeGreaterThanOrEqual(4);
  });

  test.each(fixtureRows)('$check $id: answer=$answer expected=$expected -> pass=$pass', (row) => {
    const criterion = codeCriterion(row.check);
    const evalCase = makeCase(row.id, row.answer, row.expected);

    expect(gradeCode(criterion, evalCase)).toEqual({
      status: 'ok',
      pass: row.pass,
      probability: row.pass ? 1 : 0,
    });
  });

  test('is not_applicable reference_missing when the case has no expected', () => {
    const criterion = codeCriterion('exact');
    const evalCase = makeCase('no-expected', 'Paris');

    expect(gradeCode(criterion, evalCase)).toEqual({
      status: 'not_applicable',
      cause: 'reference_missing',
    });
  });

  test('is not_applicable answer_missing when the case has no input.answer', () => {
    const criterion = codeCriterion('exact');
    const evalCase = makeCase('no-answer', undefined, 'Paris');

    expect(gradeCode(criterion, evalCase)).toEqual({
      status: 'not_applicable',
      cause: 'answer_missing',
    });
  });

  test('is not_applicable reference_missing when the criterion has no code grader', () => {
    const criterion = judgeCriterion({ checkable: 'factual' });
    const evalCase = makeCase('judge-graded', 'Paris', 'Paris');

    expect(gradeCode(criterion, evalCase)).toEqual({
      status: 'not_applicable',
      cause: 'reference_missing',
    });
  });
});

describe('referenceRequirement', () => {
  test('is ok for a criterion without checkable, regardless of cases', () => {
    const criterion = judgeCriterion();
    const cases = [makeCase('a', 'x'), makeCase('b', 'y')];

    expect(referenceRequirement(criterion, cases)).toEqual({ ok: true });
  });

  test('is reference_missing for a checkable criterion graded by the judge', () => {
    const criterion = judgeCriterion({ checkable: 'factual' });
    const cases = [makeCase('a', 'x', 'x'), makeCase('b', 'y', 'y')];

    const result = referenceRequirement(criterion, cases);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ok:false');
    expect(result.reason).toBe('reference_missing');
  });

  test('is ok for a checkable criterion with a reference grader when every case has expected', () => {
    const criterion = referenceCriterion('q');
    const cases = [makeCase('a', 'x', 'x'), makeCase('b', 'y', 'y')];

    expect(referenceRequirement(criterion, cases)).toEqual({ ok: true });
  });

  test('lists exactly the case missing expected when one of several is missing it', () => {
    const criterion = referenceCriterion('q');
    const cases = [makeCase('a', 'x', 'x'), makeCase('b', 'y')];

    expect(referenceRequirement(criterion, cases)).toEqual({
      ok: false,
      reason: 'reference_missing',
      missing: ['b'],
    });
  });
});
