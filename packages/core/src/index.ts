// Named re-exports only — no `export *` (oxc/no-barrel-file, docs/contracts/j0.md
// DECISION: Code conventions).

export { computeWordingHash, loadCriteria } from './criteria/load.ts';
export type { CriteriaIssue, LoadCriteriaResult, WordingFields } from './criteria/load.ts';

export { loadCases, MAX_STATE_TOKENS } from './cases/load.ts';
export type { CaseIssue, CaseLocation, LoadCasesResult } from './cases/load.ts';

export { gradeCode, referenceRequirement, renderReference } from './judge/reference.ts';
export type { GradeCodeResult, ReferenceRequirementResult } from './judge/reference.ts';

export { DEFAULT_FORBIDDEN_WORDS, LINT_RULES, lintCriteria } from './criteria/lint.ts';
export type {
  LintIssue,
  LintOptions,
  LintRule,
  LintRuleId,
  LintSeverity,
} from './criteria/lint.ts';

export {
  clusteredSE,
  clusterKeys,
  nearDuplicateClusters,
  pairedClusteredDiff,
} from './validate/clusters.ts';
export type {
  ClusteredSEResult,
  NearDuplicateEvent,
  NearDuplicateOptions,
  NearDuplicateResult,
  PairedClusteredDiffResult,
} from './validate/clusters.ts';

export { buildRequest, cacheKey, judgeCase } from './judge/request.ts';
export type { BuildRequestOptions, JudgeCaseInput, JudgeRequest } from './judge/request.ts';
export { createFileCache } from './judge/cache.ts';
export type {
  CacheDiagEvent,
  CachedJudgment,
  FileCacheOptions,
  VerdictCache,
} from './judge/cache.ts';

export { createLimiter } from './judge/pacing.ts';
export type { Limiter, LimiterOptions, LimiterStats, PacingEvent } from './judge/pacing.ts';

export { decideExit, evaluateGate } from './gate.ts';
export type {
  DecideExitInput,
  EvaluateGateInput,
  ExitCode,
  GatePolicy,
  GateResult,
} from './gate.ts';
export { runEvals, runJudge } from './run.ts';
export type {
  CriterionSummary,
  RunConfig,
  RunEvalsInput,
  RunEvalsResult,
  RunEvent,
  RunJudgeInput,
  RunSummary,
  RunVerdict,
  Saturation,
} from './run.ts';

export {
  bandCases,
  calibrate,
  correctedPassRate,
  repeatTolerance,
  repeatValues,
  splitByHash,
} from './validate/calibrate.ts';
export type {
  CalibrateOptions,
  CalibrationLabel,
  CalibrationResult,
  Confusion,
  CorrectedPassRateInput,
  CorrectedPassRateResult,
  LanguageSlice,
  ReliabilityBin,
} from './validate/calibrate.ts';

export {
  defineConfig,
  describeConfig,
  readEnvName,
  resolveConfig,
  validateConfig,
} from './config.ts';
export type {
  ConfigIssue,
  GeneratorAdapter,
  GeneratorEndpoint,
  JudgeEndpoint,
  RegistryEntry,
  ResolveConfigResult,
  ResolvedConfig,
  VetkitConfig,
} from './config.ts';
