// Named re-exports only — no `export *` (oxc/no-barrel-file).
export { createOtelSink } from './log-sink.ts';
export type { CreateOtelSinkOptions } from './log-sink.ts';

export { EVENT_NAME, SEMCONV_SCHEMA_URL, verdictToLogRecord } from './encode.ts';
export type { OtlpAttribute, OtlpLogRecord } from './encode.ts';
