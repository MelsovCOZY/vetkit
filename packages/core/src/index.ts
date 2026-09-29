// Named re-exports only — no `export *` (oxc/no-barrel-file).

export { computeWordingHash, loadCriteria } from './criteria/load.ts';
export type { CriteriaIssue, LoadCriteriaResult, WordingFields } from './criteria/load.ts';
export { computeNormalizedWordingHash, wordingOf } from './criteria/wording.ts';
export {
  formatCriteriaDocument,
  markUncalibrated,
  parseCriteriaDocument,
  removeCriterion,
  removeLockEntry,
  setEnabled,
} from './criteria/edit.ts';
export type {
  CriteriaDocument,
  EditResult,
  MarkUncalibratedResult,
  ParseCriteriaDocumentResult,
} from './criteria/edit.ts';

export { loadCases, MAX_STATE_TOKENS } from './cases/load.ts';
export type { CaseIssue, CaseLocation, LoadCasesResult } from './cases/load.ts';

export {
  dedupeKey,
  findDuplicates,
  listPendingCases,
  promoteVerdict,
  quarantineCase,
  removeCases,
  reviewCase,
} from './cases/edit.ts';
export type { DuplicatePair, PendingCase, QuarantineResult, ReviewOptions } from './cases/edit.ts';

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
export { decideVerdict, runEvals, runJudge } from './run.ts';
export type {
  CriterionSummary,
  DecideVerdictResult,
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

export {
  formatLabelRow,
  LABEL_CSV_HEADER,
  loadLabels,
  parseCsv,
  parseLabels,
} from './validate/labels.ts';
export type {
  CsvRecord,
  LabelEntry,
  LabelIdSets,
  LabelIssue,
  LabelRow,
  LabelSet,
  LabelValue,
  LabelWarning,
  LoadLabelsResult,
  ParseLabelsResult,
} from './validate/labels.ts';

export { createEvents, EVENT_NAMES } from './events.ts';
export type {
  DiagData,
  DiagEvent,
  DiagLevel,
  EventMap,
  EventName,
  Events,
  Listener,
} from './events.ts';

export { gauntletLength, gauntletPositionSwap } from './validate/gauntlet-bias.ts';
export type {
  GauntletBiasEvent,
  GauntletBiasSkipReason,
  LengthOptions,
  LengthResult,
  PaddingTemplate,
  PositionSwapOptions,
  PositionSwapResult,
} from './validate/gauntlet-bias.ts';

export {
  gauntletConstantOutput,
  gauntletInjection,
  gauntletLabelPermutation,
  gauntletMasterKey,
  INJECTION_KINDS,
} from './validate/gauntlet-controls.ts';
export type {
  ConstantEntry,
  ConstantOutputOptions,
  ConstantOutputResult,
  FamilyScore,
  GauntletControlsSkipReason,
  GauntletJudgeOptions,
  InjectionEntry,
  InjectionKind,
  InjectionOptions,
  InjectionResult,
  LabelPermutationOptions,
  LabelPermutationResult,
  MasterKeyEntry,
  MasterKeyOptions,
  MasterKeyResult,
  PermutationVerdict,
} from './validate/gauntlet-controls.ts';

export { DEFAULT_CALLS_PER_MINUTE, estimateRun, estimateValidate } from './estimate.ts';
export type {
  CostEstimate,
  EstimatePart,
  EstimatePricing,
  EstimateRunInput,
  EstimateValidateInput,
  RunEstimate,
  Unknowable,
  ValidateEstimate,
} from './estimate.ts';

export { CALIBRATION_MIN_REPEATS } from './validate/calibrate.ts';
export { POSITION_SWAP_MAX_ORDERS } from './validate/gauntlet-bias.ts';
export { MASTER_KEY_MIN_REPEATS } from './validate/gauntlet-controls.ts';

export { createOutbox } from './outbox/outbox.ts';
export type { DrainResult, Outbox, OutboxOptions, ReconcileResult } from './outbox/outbox.ts';

export { gauntletParaphrase, gauntletPolarity } from './validate/gauntlet-wording.ts';
export type {
  GauntletWordingSkipReason,
  ParaphraseOptions,
  ParaphraseResult,
  PolarityResult,
  WordingJudgeOptions,
} from './validate/gauntlet-wording.ts';

export { proposeFailureModes } from './generate/failure-modes.ts';
export type { FailureMode, ProposeFailureModesInput } from './generate/failure-modes.ts';
export { proposeCriteria } from './generate/criteria.ts';
export type { ProposeCriteriaInput, ProposeCriteriaResult } from './generate/criteria.ts';
export {
  CRITERIA_PROMPT,
  CRITERIA_SCHEMA,
  FAILURE_MODES_PROMPT,
  FAILURE_MODES_SCHEMA,
  promptHash,
} from './generate/prompts.ts';

export { extractCases } from './generate/cases.ts';
export type { ExtractCasesInput, ExtractCasesResult, TraceStatus } from './generate/cases.ts';
export { dedupeCriteria } from './generate/dedupe.ts';
export type {
  DedupeCriteriaInput,
  DedupeCriteriaResult,
  DuplicateRecord,
} from './generate/dedupe.ts';
export { generateEvals } from './generate/pipeline.ts';
export type {
  GenerateConfig,
  GenerateEvalsInput,
  GenerateEvalsResult,
  GenerateIssue,
  GenerateReport,
} from './generate/pipeline.ts';

export {
  assertLockGates,
  buildLock,
  checkLock,
  datasetHash,
  flippedFamilies,
  LOCK_FILE,
  lockEntryGateable,
  masterKeyFailures,
  readLock,
  judgeUnavailable,
  readLockOrNull,
  unscoredOf,
  writeLockAtomic,
} from './validate/lock.ts';
export type {
  CheckLockCurrent,
  LockCriterionInput,
  LockGateFlags,
  LockGateResult,
  LockInputs,
  StaleReason,
  StaleReport,
  Unscored,
  WriteLockOptions,
} from './validate/lock.ts';

export { readRunRecord, writeRunRecord } from './run-record.ts';
export type { RunRecord } from './run-record.ts';

export { DEFAULT_GAUNTLET_CORPORA } from './validate/corpora.ts';
export type { DefaultCorpora } from './validate/corpora.ts';

// Watch: exported for packages/cli/src/commands/watch.ts.
export { runWatch } from './watch/loop.ts';
export type { CoverageSummary, JudgeCaseFn, RunWatchInput, RunWatchOptions } from './watch/loop.ts';
export { createSampler, hashToUnit } from './watch/sampler.ts';
export type { Sampler, SamplerOptions } from './watch/sampler.ts';
export { promoteFailure } from './watch/promote.ts';
export type { PromoteFailureOptions } from './watch/promote.ts';
export type { InclusionRecord, PromotedCase, WatchOptions } from './watch/types.ts';
