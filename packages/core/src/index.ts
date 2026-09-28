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
