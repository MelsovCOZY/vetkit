import type { Lock, LockCriterion } from '@vetkit/spec';
import { describe, expect, test } from 'vitest';
import {
  formatCriteriaDocument,
  markUncalibrated,
  parseCriteriaDocument,
  removeCriterion,
  removeLockEntry,
  setEnabled,
} from './edit.ts';

const YAML = `# top comment
criteria:
  # the first criterion
  - id: answers-question
    type: boolean
    instructions: Does the reply answer the question?
    escape: The reply is empty.
    polarity: pass_when_true
    channel: outcome
    provenance: { traceIds: [] }
  - id: is-rude # inline comment
    type: boolean
    instructions: Is the reply rude?
    escape: The reply is empty.
    polarity: pass_when_false
    channel: safety
    provenance: { traceIds: [] }
`;

function parsed() {
  const result = parseCriteriaDocument(YAML);
  if (!result.ok) throw new Error(result.message);
  return result.doc;
}

function entry(over: Partial<LockCriterion> = {}): LockCriterion {
  return {
    wordingHash: 'a'.repeat(64),
    status: 'calibrated',
    threshold: 0.7,
    tolerance: 0.05,
    gauntlet: {
      paraphrase: 'pass',
      polarity: 'pass',
      injection: 'pass',
      master_key: 'pass',
      label_permutation: 'pass',
      constant_output: 'pass',
      position_swap: 'pass',
      length: 'pass',
    },
    reasons: [],
    labelCount: 120,
    ...over,
  };
}

function lock(): Lock {
  return {
    lockVersion: 1,
    model: { requested: 'm', resolved: 'm-1', transport: 't', pinned: true },
    criteria: { 'answers-question': entry(), 'is-rude': entry() },
    datasetHash: 'd'.repeat(64),
  };
}

describe('parseCriteriaDocument', () => {
  test('invalid YAML is an error result, not a throw', () => {
    const result = parseCriteriaDocument('criteria: [unclosed');
    expect(result.ok).toBe(false);
  });
});

describe('setEnabled', () => {
  test('disable writes enabled: false on that criterion and keeps comments and order', () => {
    const doc = parsed();
    expect(setEnabled(doc, 'is-rude', false)).toEqual({ ok: true });
    const out = formatCriteriaDocument(doc);

    expect(out).toContain('# top comment');
    expect(out).toContain('# the first criterion');
    expect(out).toContain('# inline comment');
    expect(out.indexOf('answers-question')).toBeLessThan(out.indexOf('is-rude'));
    const rude = out.slice(out.indexOf('- id: is-rude'));
    expect(rude).toMatch(/\n {4}enabled: false\n/);
    expect(out.slice(0, out.indexOf('- id: is-rude'))).not.toContain('enabled');
  });

  test('enable again removes the enabled key (absent means enabled)', () => {
    const doc = parsed();
    setEnabled(doc, 'is-rude', false);
    expect(setEnabled(doc, 'is-rude', true)).toEqual({ ok: true });
    expect(formatCriteriaDocument(doc)).not.toContain('enabled');
  });

  test('an unknown id is a CRITERIA_INVALID error naming the id', () => {
    const result = setEnabled(parsed(), 'ghost', false);
    expect(result).toMatchObject({ ok: false, code: 'CRITERIA_INVALID' });
    expect(result.ok ? '' : result.message).toContain('ghost');
  });
});

describe('removeCriterion', () => {
  test('removes only that criterion and keeps the rest with comments', () => {
    const doc = parsed();
    expect(removeCriterion(doc, 'is-rude')).toEqual({ ok: true });
    const out = formatCriteriaDocument(doc);
    expect(out).not.toContain('is-rude');
    expect(out).toContain('- id: answers-question');
    expect(out).toContain('# the first criterion');
  });

  test('an unknown id is a CRITERIA_INVALID error', () => {
    expect(removeCriterion(parsed(), 'ghost')).toMatchObject({
      ok: false,
      code: 'CRITERIA_INVALID',
    });
  });
});

describe('removeLockEntry', () => {
  test('returns a lock without that entry and leaves the input and other hashes as they were', () => {
    const before = lock();
    const after = removeLockEntry(before, 'is-rude');
    expect(Object.keys(after.criteria)).toEqual(['answers-question']);
    expect(after.datasetHash).toBe(before.datasetHash);
    expect(after.criteria['answers-question']).toEqual(before.criteria['answers-question']);
    expect(before.criteria['is-rude']).toBeDefined();
  });
});

describe('markUncalibrated', () => {
  test('sets status uncalibrated and clears the threshold, keeping the wordingHash', () => {
    const before = lock();
    const result = markUncalibrated(before, 'is-rude');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const updated = result.lock.criteria['is-rude'];
    expect(updated?.status).toBe('uncalibrated');
    expect(updated?.threshold).toBeUndefined();
    expect(updated?.wordingHash).toBe('a'.repeat(64));
    expect(before.criteria['is-rude']?.status).toBe('calibrated');
  });

  test('an id with no lock entry is a CRITERIA_INVALID error', () => {
    expect(markUncalibrated(lock(), 'ghost')).toMatchObject({
      ok: false,
      code: 'CRITERIA_INVALID',
    });
  });
});
