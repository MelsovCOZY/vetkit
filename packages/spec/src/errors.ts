// Errors carry a Symbol.for marker + string code + cause + static isInstance,
// never `instanceof` across packages (module copies get their own VetError
// class, but Symbol.for is a single global registry, so the marker survives).
// docs/research/2026-09-25-typescript-practices-and-boilerplates-brief.md §4.

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
} as const;

export type CevErrorCode = (typeof CEV_ERROR_CODES)[keyof typeof CEV_ERROR_CODES];

const VETKIT_ERROR_MARKER = Symbol.for('vetkit.error');

export class VetError extends Error {
  readonly code: CevErrorCode;

  constructor(code: CevErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'VetError';
    this.code = code;
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
