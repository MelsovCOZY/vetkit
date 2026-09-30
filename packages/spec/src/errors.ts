// Errors carry a Symbol.for marker + string code + cause + static isInstance,
// never `instanceof` across packages (module copies get their own VetError
// class, but Symbol.for is a single global registry, so the marker survives).

export const CEV_ERROR_CODES = {
  E_CONFIG: 'E_CONFIG',
  E_ADAPTER_SPEC_VERSION: 'E_ADAPTER_SPEC_VERSION',
  E_ADAPTER_CAPABILITY: 'E_ADAPTER_CAPABILITY',
  E_SCHEMA_INVALID: 'E_SCHEMA_INVALID',
  E_JSON_PARSE: 'E_JSON_PARSE',
  E_IO: 'E_IO',
  E_NETWORK: 'E_NETWORK',
  E_TIMEOUT: 'E_TIMEOUT',
  E_AUTH: 'E_AUTH',
  E_RATE_LIMIT: 'E_RATE_LIMIT',
  E_UNPINNED_LOCK: 'E_UNPINNED_LOCK',
  E_UNCALIBRATED: 'E_UNCALIBRATED',
  // Unprefixed codes for the judge port, config/IR validation and the gate, including
  // JUDGE_UNAUTHORIZED and INPUT_TOO_LARGE. The E_* codes above are kept as they are.
  CONFIG_INVALID: 'CONFIG_INVALID',
  CRITERIA_INVALID: 'CRITERIA_INVALID',
  CASE_INVALID: 'CASE_INVALID',
  JUDGE_UNAVAILABLE: 'JUDGE_UNAVAILABLE',
  JUDGE_TIMEOUT: 'JUDGE_TIMEOUT',
  JUDGE_BAD_RESPONSE: 'JUDGE_BAD_RESPONSE',
  GATE_REFUSED: 'GATE_REFUSED',
  CACHE_IO: 'CACHE_IO',
  JUDGE_UNAUTHORIZED: 'JUDGE_UNAUTHORIZED',
  INPUT_TOO_LARGE: 'INPUT_TOO_LARGE',
  // Calibration labels, lock staleness, the gate's refusal reasons, and
  // the two CLI conditions resolveExit maps to exit codes 2 and 3.
  LABELS_TOO_FEW: 'LABELS_TOO_FEW',
  LOCK_STALE: 'LOCK_STALE',
  GATE_UNCALIBRATED: 'GATE_UNCALIBRATED',
  GATE_UNPINNED: 'GATE_UNPINNED',
  NOT_INTERACTIVE: 'NOT_INTERACTIVE',
  UNSCORED_ONLY: 'UNSCORED_ONLY',
  // a malformed labels row, exit 2 naming file:line.
  LABELS_INVALID: 'LABELS_INVALID',
  // Sink write outcomes and the outbox's
  // corrupt-file config error. OUTBOX_CORRUPT is thrown, never a doWrite rejection.
  SINK_REJECTED: 'SINK_REJECTED',
  SINK_UNREACHABLE: 'SINK_UNREACHABLE',
  SINK_AUTH: 'SINK_AUTH',
  SINK_PAYLOAD_TOO_LARGE: 'SINK_PAYLOAD_TOO_LARGE',
  OUTBOX_CORRUPT: 'OUTBOX_CORRUPT',
  // `vet run --sink` names a sink that vetkit.config.ts does not configure (exit 2).
  CONFIG_UNKNOWN_SINK: 'CONFIG_UNKNOWN_SINK',
  // Source reads, trace validation and generator outcomes. GENERATOR_CAPABILITY is a
  // declared-strategy mismatch, never a silent downgrade.
  SOURCE_UNREADABLE: 'SOURCE_UNREADABLE',
  TRACE_INVALID: 'TRACE_INVALID',
  GENERATOR_UNAVAILABLE: 'GENERATOR_UNAVAILABLE',
  GENERATOR_BAD_OUTPUT: 'GENERATOR_BAD_OUTPUT',
  GENERATOR_CAPABILITY: 'GENERATOR_CAPABILITY',
  // An OTLP body that is not an
  // ExportTraceServiceRequest, a non-JSON body at the receiver (HTTP 415), and a source that
  // produced 0 traces.
  OTLP_PARSE: 'OTLP_PARSE',
  OTLP_UNSUPPORTED_CONTENT_TYPE: 'OTLP_UNSUPPORTED_CONTENT_TYPE',
  SOURCE_EMPTY: 'SOURCE_EMPTY',
  // `vet rerun` finds no persisted run record (<cacheDir>/runs/latest.json) to re-judge from; exits 2 (cli errors.ts).
  RUN_NOT_FOUND: 'RUN_NOT_FOUND',
  // The Langfuse source: a 401/403 from the Langfuse
  // API, or a missing credential, thrown at first read (SOURCE_ prefix -> cli errors.ts
  // resolveExit's existing sinkSource rule, no CLI change needed). SOURCE_UNREACHABLE is a
  // 429 exhausted after 3 retries, or any other non-OK response.
  SOURCE_AUTH: 'SOURCE_AUTH',
  SOURCE_UNREACHABLE: 'SOURCE_UNREACHABLE',
  // `vet export --to <id>` (an unregistered exporter id) and `vet export
  // --require-lock` (no criteria.lock.json); both exit 2 (cli errors.ts EXPORT_* rule).
  EXPORT_TARGET_UNKNOWN: 'EXPORT_TARGET_UNKNOWN',
  EXPORT_NO_LOCK: 'EXPORT_NO_LOCK',
  // `vet watch`'s receiver bind
  // failure and an out-of-range --sample. Both exit 2 (cli errors.ts).
  RECEIVER_BIND: 'RECEIVER_BIND',
  WATCH_CONFIG: 'WATCH_CONFIG',
} as const;

export type CevErrorCode = (typeof CEV_ERROR_CODES)[keyof typeof CEV_ERROR_CODES];

/** How a judge failure should be treated: retried, or fatal for the whole run. */
export type VetErrorKind = 'retryable' | 'terminal-auth' | 'terminal-billing' | 'terminal-request';

// Additive detail bag for the judge/gate/cache paths, carried through the constructor's `options.details`, never required, never replacing
// `cause`.
export interface VetErrorDetails {
  readonly retryable?: boolean;
  readonly hint?: string;
  readonly retryAfterMs?: number;
  readonly requestId?: string;
  readonly kind?: VetErrorKind;
}

export interface VetErrorOptions extends ErrorOptions {
  readonly details?: VetErrorDetails;
}

const VETKIT_ERROR_MARKER = Symbol.for('vetkit.error');

export class VetError extends Error {
  readonly code: CevErrorCode;
  readonly details?: VetErrorDetails;

  constructor(code: CevErrorCode, message: string, options?: VetErrorOptions) {
    super(message, options);
    this.name = 'VetError';
    this.code = code;
    if (options?.details !== undefined) {
      this.details = options.details;
    }
    // Computed class fields can't be typed under isolatedDeclarations (TS1166:
    // a computed property name in a class field needs a literal or `unique
    // symbol` type, and `Symbol.for` returns plain `symbol`), so the marker is
    // set here instead of as a field declaration. The cast to index by symbol
    // is the trusted boundary for that marker.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    (this as Record<symbol, unknown>)[VETKIT_ERROR_MARKER] = true;
  }

  static isInstance(x: unknown): x is VetError {
    return (
      typeof x === 'object' &&
      x !== null &&
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      (x as Record<symbol, unknown>)[VETKIT_ERROR_MARKER] === true
    );
  }
}
