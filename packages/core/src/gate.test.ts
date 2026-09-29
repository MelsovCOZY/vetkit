import { describe, expect, test } from 'vitest';
import type { GauntletResult, Lock, LockCriterion, Verdict } from '@vetkit/spec';
import { evaluateGate } from './gate.ts';

const PASS: GauntletResult = {
  paraphrase: 'pass',
  polarity: 'pass',
  injection: 'pass',
  master_key: 'pass',
  label_permutation: 'pass',
  constant_output: 'pass',
  position_swap: 'pass',
  length: 'pass',
};

function entry(status: LockCriterion['status']): LockCriterion {
  return { wordingHash: 'a'.repeat(64), status, gauntlet: PASS, reasons: [], labelCount: 120 };
}

function lock(status: LockCriterion['status'], pinned: boolean): Lock {
  return {
    lockVersion: 1,
    model: { requested: 'j', resolved: 'j-1', transport: 'alias-gateway', pinned },
    criteria: { a: entry(status) },
    datasetHash: 'b'.repeat(64),
  };
}

function verdict(pass: boolean, pinned: boolean): Verdict {
  return {
    caseId: 'c1',
    criterionId: 'a',
    status: 'ok',
    model: { requested: 'j', resolved: 'j-1', transport: 'alias-gateway', pinned },
    cacheHit: false,
    answer: { type: 'boolean', probability: pass ? 0.9 : 0.1 },
    pass,
    gated: true,
  };
}

describe('evaluateGate', () => {
  test('a floating lock passes under allowUnpinned and exits by results', () => {
    const policy = { requireCalibrated: true, allowUnpinned: true };
    const ok = evaluateGate({
      verdicts: [verdict(true, false)],
      lock: lock('floating', false),
      policy,
    });
    expect(ok).toEqual({ exitCode: 0, reasons: [] });
    const bad = evaluateGate({
      verdicts: [verdict(false, false)],
      lock: lock('floating', false),
      policy,
    });
    expect(bad.exitCode).toBe(1);
  });

  test('a floating lock is refused without allowUnpinned', () => {
    const out = evaluateGate({
      verdicts: [verdict(true, false)],
      lock: lock('floating', false),
      policy: { requireCalibrated: true, allowUnpinned: false },
    });
    expect(out.exitCode).toBe(2);
    expect(out.reasons.join('\n')).toContain("'a'");
  });

  test('an uncalibrated entry is refused even under allowUnpinned', () => {
    const out = evaluateGate({
      verdicts: [verdict(true, true)],
      lock: lock('uncalibrated', true),
      policy: { requireCalibrated: true, allowUnpinned: true },
    });
    expect(out.exitCode).toBe(2);
  });

  test('the no-lock refusal names criteria.lock.json', () => {
    const out = evaluateGate({
      verdicts: [],
      lock: null,
      policy: { requireCalibrated: true, allowUnpinned: true },
    });
    expect(out.exitCode).toBe(2);
    expect(out.reasons.join('\n')).toContain('criteria.lock.json');
  });
});
