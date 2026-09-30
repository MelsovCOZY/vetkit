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

function served(resolved: string, over: Partial<Verdict> = {}): Verdict {
  const base = verdict(true, true);
  return { ...base, model: { ...base.model, resolved }, ...over };
}

describe('served model identity', () => {
  const policy = { requireCalibrated: true, allowUnpinned: false };

  test('a differing served id refuses with exit 2 naming both ids', () => {
    const out = evaluateGate({
      verdicts: [served('j-2')],
      lock: lock('calibrated', true),
      policy,
    });
    expect(out.exitCode).toBe(2);
    expect(out.reasons).toEqual([
      "served model 'j-2' differs from the lock's 'j-1' (run `vet validate` against the current judge)",
    ]);
  });

  test('an empty resolved id is ignored', () => {
    const out = evaluateGate({
      verdicts: [served('')],
      lock: lock('calibrated', true),
      policy,
    });
    expect(out).toEqual({ exitCode: 0, reasons: [] });
  });

  test('two differing ids give two sorted reasons', () => {
    const out = evaluateGate({
      verdicts: [served('j-9'), served('j-2'), served('j-9')],
      lock: lock('calibrated', true),
      policy,
    });
    expect(out.exitCode).toBe(2);
    expect(out.reasons).toHaveLength(2);
    expect(out.reasons[0]).toContain("'j-2'");
    expect(out.reasons[1]).toContain("'j-9'");
  });

  test('matching ids fall through to results', () => {
    const ok = evaluateGate({
      verdicts: [served('j-1')],
      lock: lock('calibrated', true),
      policy,
    });
    expect(ok).toEqual({ exitCode: 0, reasons: [] });
    const bad = evaluateGate({
      verdicts: [served('j-1', { pass: false })],
      lock: lock('calibrated', true),
      policy,
    });
    expect(bad.exitCode).toBe(1);
  });

  test('ungated and code-graded verdicts never trigger the served-id refusal', () => {
    const code = served('code:exact');
    const out = evaluateGate({
      verdicts: [
        served('j-2', { gated: false }),
        { ...code, model: { ...code.model, transport: 'code' } },
      ],
      lock: lock('calibrated', true),
      policy,
    });
    expect(out.reasons).toEqual([]);
  });
});
