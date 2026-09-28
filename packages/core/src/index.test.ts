import { describe, expect, it } from 'vitest';
import {
  clusteredSE,
  clusterKeys,
  computeWordingHash,
  DEFAULT_FORBIDDEN_WORDS,
  gradeCode,
  LINT_RULES,
  lintCriteria,
  loadCases,
  loadCriteria,
  MAX_STATE_TOKENS,
  nearDuplicateClusters,
  pairedClusteredDiff,
  referenceRequirement,
  renderReference,
} from './index.ts';

describe('@vetkit/core package entry', () => {
  it('re-exports loadCriteria as a function', () => {
    expect(typeof loadCriteria).toBe('function');
  });

  it('re-exports computeWordingHash as a function', () => {
    expect(typeof computeWordingHash).toBe('function');
  });

  it('re-exports loadCases as a function', () => {
    expect(typeof loadCases).toBe('function');
  });

  it('re-exports renderReference as a function', () => {
    expect(typeof renderReference).toBe('function');
  });

  it('re-exports gradeCode as a function', () => {
    expect(typeof gradeCode).toBe('function');
  });

  it('re-exports referenceRequirement as a function', () => {
    expect(typeof referenceRequirement).toBe('function');
  });

  it('re-exports MAX_STATE_TOKENS as 32_000', () => {
    expect(MAX_STATE_TOKENS).toBe(32_000);
  });

  it('re-exports lintCriteria as a function', () => {
    expect(typeof lintCriteria).toBe('function');
  });

  it('re-exports LINT_RULES as an array', () => {
    expect(Array.isArray(LINT_RULES)).toBe(true);
  });

  it('re-exports DEFAULT_FORBIDDEN_WORDS containing good', () => {
    expect(DEFAULT_FORBIDDEN_WORDS).toContain('good');
  });

  it('re-exports nearDuplicateClusters as a function', () => {
    expect(typeof nearDuplicateClusters).toBe('function');
  });

  it('re-exports clusterKeys as a function', () => {
    expect(typeof clusterKeys).toBe('function');
  });

  it('re-exports clusteredSE as a function', () => {
    expect(typeof clusteredSE).toBe('function');
  });

  it('re-exports pairedClusteredDiff as a function', () => {
    expect(typeof pairedClusteredDiff).toBe('function');
  });
});
