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
  gauntletConstantOutput,
  gauntletInjection,
  gauntletLabelPermutation,
  gauntletMasterKey,
  gradeCode,
  INJECTION_KINDS,
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

import { gauntletLength, gauntletPositionSwap } from './index.ts';
import { DEFAULT_CALLS_PER_MINUTE, estimateRun, estimateValidate } from './index.ts';
import {
  CALIBRATION_MIN_REPEATS,
  MASTER_KEY_MIN_REPEATS,
  POSITION_SWAP_MAX_ORDERS,
} from './index.ts';
import { createOutbox } from './index.ts';
import { gauntletParaphrase, gauntletPolarity } from './index.ts';
import {
  CRITERIA_PROMPT,
  CRITERIA_SCHEMA,
  FAILURE_MODES_PROMPT,
  FAILURE_MODES_SCHEMA,
  promptHash,
  proposeCriteria,
  proposeFailureModes,
} from './index.ts';
import { dedupeCriteria, extractCases, generateEvals } from './index.ts';

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

  it('re-exports gauntletPositionSwap as a function', () => {
    expect(typeof gauntletPositionSwap).toBe('function');
  });

  it('re-exports gauntletLength as a function', () => {
    expect(typeof gauntletLength).toBe('function');
  });

  it('re-exports gauntletInjection as a function', () => {
    expect(typeof gauntletInjection).toBe('function');
  });

  it('re-exports gauntletMasterKey as a function', () => {
    expect(typeof gauntletMasterKey).toBe('function');
  });

  it('re-exports gauntletLabelPermutation as a function', () => {
    expect(typeof gauntletLabelPermutation).toBe('function');
  });

  it('re-exports gauntletConstantOutput as a function', () => {
    expect(typeof gauntletConstantOutput).toBe('function');
  });

  it('re-exports INJECTION_KINDS naming the imperative and multi_turn families', () => {
    expect(INJECTION_KINDS).toContain('imperative');
    expect(INJECTION_KINDS).toContain('multi_turn');
  });

  it('re-exports estimateRun and estimateValidate as functions', () => {
    expect(typeof estimateRun).toBe('function');
    expect(typeof estimateValidate).toBe('function');
  });

  it('re-exports DEFAULT_CALLS_PER_MINUTE as 25', () => {
    expect(DEFAULT_CALLS_PER_MINUTE).toBe(25);
  });

  it('re-exports CALIBRATION_MIN_REPEATS as 3 (J3 judge repeats per labelled case)', () => {
    expect(CALIBRATION_MIN_REPEATS).toBe(3);
  });

  it('re-exports POSITION_SWAP_MAX_ORDERS as 6 (option orders judged per case at most)', () => {
    expect(POSITION_SWAP_MAX_ORDERS).toBe(6);
  });

  it('re-exports MASTER_KEY_MIN_REPEATS as 3 (repeats per master-key input at least)', () => {
    expect(MASTER_KEY_MIN_REPEATS).toBe(3);
  });

  it('re-exports createOutbox as a function', () => {
    expect(typeof createOutbox).toBe('function');
  });

  it('re-exports gauntletParaphrase and gauntletPolarity as functions', () => {
    expect(typeof gauntletParaphrase).toBe('function');
    expect(typeof gauntletPolarity).toBe('function');
  });

  it('re-exports proposeFailureModes and proposeCriteria as functions', () => {
    expect(typeof proposeFailureModes).toBe('function');
    expect(typeof proposeCriteria).toBe('function');
  });

  it('re-exports promptHash as a deterministic sha256-hex function', () => {
    expect(promptHash('a')).toMatch(/^[0-9a-f]{64}$/);
    expect(promptHash('a')).toBe(promptHash('a'));
    expect(promptHash('a')).not.toBe(promptHash('b'));
  });

  it('re-exports FAILURE_MODES_PROMPT naming the error-analysis task', () => {
    expect(FAILURE_MODES_PROMPT).toContain('error analysis on traces');
  });

  it('re-exports CRITERIA_PROMPT naming the yes/no question-writing task', () => {
    expect(CRITERIA_PROMPT).toContain('yes/no evaluation questions');
  });

  it('re-exports FAILURE_MODES_SCHEMA requiring failureModes', () => {
    expect(JSON.stringify(FAILURE_MODES_SCHEMA)).toContain('failureModes');
  });

  it('re-exports CRITERIA_SCHEMA requiring criteria', () => {
    expect(JSON.stringify(CRITERIA_SCHEMA)).toContain('criteria');
  });

  it('re-exports generateEvals as a function', () => {
    expect(typeof generateEvals).toBe('function');
  });

  it('re-exports extractCases as a function', () => {
    expect(typeof extractCases).toBe('function');
  });

  it('re-exports dedupeCriteria as a function', () => {
    expect(typeof dedupeCriteria).toBe('function');
  });
});

import {
  assertLockGates,
  buildLock,
  checkLock,
  datasetHash,
  lockEntryGateable,
  readLock,
  readLockOrNull,
  writeLockAtomic,
} from './index.ts';

describe('@vetkit/core lock exports (q4q.6)', () => {
  it('re-exports the lock functions', () => {
    for (const fn of [
      assertLockGates,
      buildLock,
      checkLock,
      lockEntryGateable,
      readLock,
      readLockOrNull,
      writeLockAtomic,
    ]) {
      expect(typeof fn).toBe('function');
    }
  });

  it('re-exports datasetHash as a sha256-hex function', () => {
    expect(datasetHash([])).toMatch(/^[0-9a-f]{64}$/);
  });
});

import { readRunRecord, writeRunRecord, type RunRecord } from './index.ts';

describe('@vetkit/core run-record exports (mol-p4a.16)', () => {
  it('re-exports readRunRecord and writeRunRecord as functions', () => {
    expect(typeof readRunRecord).toBe('function');
    expect(typeof writeRunRecord).toBe('function');
  });

  it('re-exports the RunRecord type carrying criteriaPath and casesPath', () => {
    const paths: Pick<RunRecord, 'criteriaPath' | 'casesPath'> = {
      criteriaPath: 'a',
      casesPath: 'b',
    };
    expect(paths.criteriaPath).toBe('a');
  });
});

import {
  formatCriteriaDocument,
  markUncalibrated,
  parseCriteriaDocument,
  removeCriterion,
  removeLockEntry,
  setEnabled,
} from './index.ts';

describe('@vetkit/core criteria edit exports (mol-e3g)', () => {
  it('re-exports the criteria edit functions', () => {
    for (const fn of [
      formatCriteriaDocument,
      markUncalibrated,
      parseCriteriaDocument,
      removeCriterion,
      removeLockEntry,
      setEnabled,
    ]) {
      expect(typeof fn).toBe('function');
    }
  });
});

import { DEFAULT_GAUNTLET_CORPORA, type DefaultCorpora } from './index.ts';

describe('@vetkit/core shipped gauntlet corpora exports (mol-q4q.12)', () => {
  it('re-exports DEFAULT_GAUNTLET_CORPORA with non-empty injections, masterKeys, constants and paddings', () => {
    expect(DEFAULT_GAUNTLET_CORPORA.injections.length).toBeGreaterThan(0);
    expect(DEFAULT_GAUNTLET_CORPORA.masterKeys.length).toBeGreaterThan(0);
    expect(DEFAULT_GAUNTLET_CORPORA.constants.length).toBeGreaterThan(0);
    expect(DEFAULT_GAUNTLET_CORPORA.paddings.length).toBeGreaterThan(0);
  });

  it('re-exports the DefaultCorpora type', () => {
    const corpora: DefaultCorpora = DEFAULT_GAUNTLET_CORPORA;
    expect(corpora.injections).toBe(DEFAULT_GAUNTLET_CORPORA.injections);
  });
});
