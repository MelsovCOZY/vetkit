import { describe, expect, it } from 'vitest';
import {
  bandCases,
  buildRequest,
  calibrate,
  cacheKey,
  clusteredSE,
  clusterKeys,
  computeWordingHash,
  correctedPassRate,
  createFileCache,
  createLimiter,
  decideExit,
  evaluateGate,
  DEFAULT_FORBIDDEN_WORDS,
  defineConfig,
  describeConfig,
  formatLabelRow,
  gradeCode,
  judgeCase,
  LABEL_CSV_HEADER,
  LINT_RULES,
  lintCriteria,
  loadCases,
  loadCriteria,
  loadLabels,
  MAX_STATE_TOKENS,
  nearDuplicateClusters,
  pairedClusteredDiff,
  parseCsv,
  parseLabels,
  readEnvName,
  referenceRequirement,
  renderReference,
  repeatTolerance,
  repeatValues,
  resolveConfig,
  runEvals,
  runJudge,
  splitByHash,
  validateConfig,
} from './index.ts';
import { createEvents, EVENT_NAMES } from './index.ts';

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

  it('re-exports createLimiter as a function', () => {
    expect(typeof createLimiter).toBe('function');
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

  it('re-exports buildRequest as a function', () => {
    expect(typeof buildRequest).toBe('function');
  });

  it('re-exports judgeCase as a function', () => {
    expect(typeof judgeCase).toBe('function');
  });

  it('re-exports cacheKey as a function', () => {
    expect(typeof cacheKey).toBe('function');
  });

  it('re-exports createFileCache as a function', () => {
    expect(typeof createFileCache).toBe('function');
  });

  it('re-exports runEvals as a function', () => {
    expect(typeof runEvals).toBe('function');
  });

  it('re-exports runJudge as a function', () => {
    expect(typeof runJudge).toBe('function');
  });

  it('re-exports evaluateGate as a function', () => {
    expect(typeof evaluateGate).toBe('function');
  });

  it('re-exports decideExit as a function', () => {
    expect(typeof decideExit).toBe('function');
  });

  it('re-exports calibrate as a function', () => {
    expect(typeof calibrate).toBe('function');
  });

  it('re-exports bandCases as a function', () => {
    expect(typeof bandCases).toBe('function');
  });

  it('re-exports correctedPassRate as a function', () => {
    expect(typeof correctedPassRate).toBe('function');
  });

  it('re-exports repeatTolerance as a function', () => {
    expect(typeof repeatTolerance).toBe('function');
  });

  it('re-exports repeatValues as a function', () => {
    expect(typeof repeatValues).toBe('function');
  });

  it('re-exports splitByHash as a function', () => {
    expect(typeof splitByHash).toBe('function');
  });

  it('re-exports defineConfig as a function', () => {
    expect(typeof defineConfig).toBe('function');
  });

  it('re-exports validateConfig as a function', () => {
    expect(typeof validateConfig).toBe('function');
  });

  it('re-exports resolveConfig as a function', () => {
    expect(typeof resolveConfig).toBe('function');
  });

  it('re-exports readEnvName as a function', () => {
    expect(typeof readEnvName).toBe('function');
  });

  it('re-exports describeConfig as a function', () => {
    expect(typeof describeConfig).toBe('function');
  });

  it('re-exports parseCsv as a function', () => {
    expect(typeof parseCsv).toBe('function');
  });

  it('re-exports parseLabels as a function', () => {
    expect(typeof parseLabels).toBe('function');
  });

  it('re-exports loadLabels as a function', () => {
    expect(typeof loadLabels).toBe('function');
  });

  it('re-exports formatLabelRow as a function', () => {
    expect(typeof formatLabelRow).toBe('function');
  });

  it('re-exports LABEL_CSV_HEADER naming the five label columns', () => {
    expect(LABEL_CSV_HEADER).toBe('case_id,criterion_id,label,labeler,labeled_at');
  });

  it('re-exports createEvents as a function', () => {
    expect(typeof createEvents).toBe('function');
  });

  it('re-exports EVENT_NAMES naming the run:start event', () => {
    expect(EVENT_NAMES.RUN_START).toBe('run:start');
  });
});
