// Named re-exports only — no `export *` (oxc/no-barrel-file).

export { CEV_ERROR_CODES, VetError } from './errors.ts';
export type { CevErrorCode } from './errors.ts';

export { safeParseJson, validateJson } from './json.ts';
export type { SecretMask } from './redact.ts';
export { MIN_SECRET_LENGTH, redactSecrets, redactSecretsDeep, secretsFrom } from './redact.ts';
export type { JsonSchema, ParseResult, ValidateJsonOptions } from './json.ts';

export {
  ADAPTER_MARKER,
  assertSpecVersion,
  defineAdapter,
  isAdapter,
  parseAdapterId,
  requireCapabilities,
} from './registry.ts';
export type { AdapterBase } from './registry.ts';

export { ADAPTER_KINDS, SPEC_VERSION } from './version.ts';
export type { AdapterKind, SpecVersion } from './version.ts';

export type {
  Case,
  Criterion,
  GauntletOutcome,
  GauntletDetail,
  GauntletResult,
  Answer as IrAnswer,
  Lock,
  LockCriterion,
  LockModel,
  LockReason,
  Model,
  SpecVersionDoc,
  Verdict,
} from './generated/index.ts';

export {
  caseSchema,
  criterionSchema,
  lockSchema,
  runRecordSchema,
  specVersionSchema,
  verdictSchema,
} from './generated/schemas.ts';

export { DEFAULT_REQUEST_FORMAT } from './ports/judge.ts';
export type { Answer, JudgeResponse, JudgeV1, Question, RequestFormat } from './ports/judge.ts';

export { defineExporter } from './ports/exporter.ts';
export type { ExporterV1 } from './ports/exporter.ts';

export { configSchema } from './generated/schemas.ts';
export type {
  AdapterRef,
  ConfigDoc,
  GateConfig,
  GeneratorEndpoint,
  JudgeEndpoint,
  PluginRef,
  ThresholdsPolicy,
  WatchConfig,
} from './generated/index.ts';

export { defineSink } from './ports/sink.ts';
export type { SinkAck, SinkV1 } from './ports/sink.ts';

export { defineSource } from './ports/source.ts';
export type { SourceV1 } from './ports/source.ts';

export { defineGenerator } from './ports/generator.ts';
export type { GeneratorV1 } from './ports/generator.ts';

export { traceSchema } from './generated/schemas.ts';
export type { Message, MessagePart, NormalizedTrace, Span } from './generated/index.ts';
