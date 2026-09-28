// Named re-exports only — no `export *` (oxc/no-barrel-file, docs/contracts/j0.md
// DECISION: Code conventions).

export { CEV_ERROR_CODES, VetError } from './errors.ts';
export type { CevErrorCode } from './errors.ts';

export { safeParseJson, validateJson } from './json.ts';
export type { JsonSchema, ParseResult } from './json.ts';

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
  Answer as IrAnswer,
  Model,
  SpecVersionDoc,
  Verdict,
} from './generated/index.ts';

export type { Answer, JudgeResponse, JudgeV1, Question } from './ports/judge.ts';
