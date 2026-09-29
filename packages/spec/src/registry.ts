// Registry mechanics for adapter objects. The registry itself is stateless: defineAdapter only marks and validates one adapter;
// core keeps its own id -> adapter map keyed by kind + id.

import { CEV_ERROR_CODES, VetError } from './errors.ts';
import { SPEC_VERSION, type AdapterKind, type SpecVersion } from './version.ts';

export interface AdapterBase {
  specVersion: SpecVersion;
  id: string;
  kind: AdapterKind;
  capabilities: Record<string, unknown>;
}

export const ADAPTER_MARKER: symbol = Symbol.for('vetkit.adapter');

const ADAPTER_ID_PATTERN = /^([a-z][a-z0-9-]*)\/([a-z][a-z0-9-]*)$/;

export function parseAdapterId(id: string): { provider: string; name: string } {
  const match = ADAPTER_ID_PATTERN.exec(id);
  const provider = match?.[1];
  const name = match?.[2];
  if (provider === undefined || name === undefined) {
    throw new VetError(
      CEV_ERROR_CODES.E_CONFIG,
      `Invalid adapter id "${id}": expected "<provider>/<name>"`,
    );
  }
  return { provider, name };
}

export function assertSpecVersion(adapter: AdapterBase): void {
  if (adapter.specVersion !== SPEC_VERSION) {
    throw new VetError(
      CEV_ERROR_CODES.E_ADAPTER_SPEC_VERSION,
      `Adapter "${adapter.id}" has specVersion "${String(adapter.specVersion)}", expected "${String(SPEC_VERSION)}"`,
    );
  }
}

export function isAdapter(x: unknown): x is AdapterBase {
  return (
    typeof x === 'object' &&
    x !== null &&
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    (x as Record<symbol, unknown>)[ADAPTER_MARKER] === true
  );
}

// Freeze is shallow (top-level object only) so adapters that lazily memoise a vendor
// client on a nested property can still do so after registration.
export function defineAdapter<T extends AdapterBase>(adapter: T): Readonly<T> {
  assertSpecVersion(adapter);
  parseAdapterId(adapter.id);
  Object.defineProperty(adapter, ADAPTER_MARKER, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return Object.freeze(adapter);
}

function capabilitySatisfied(required: unknown[] | boolean | number, actual: unknown): boolean {
  if (Array.isArray(required)) {
    return Array.isArray(actual) && required.every((item) => actual.includes(item));
  }
  if (typeof required === 'boolean') {
    return actual === required;
  }
  return typeof actual === 'number' && actual >= required;
}

export function requireCapabilities(
  adapter: AdapterBase,
  required: Record<string, unknown[] | boolean | number>,
): void {
  const missing = Object.entries(required)
    .filter(([name, requirement]) => !capabilitySatisfied(requirement, adapter.capabilities[name]))
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new VetError(
      CEV_ERROR_CODES.E_ADAPTER_CAPABILITY,
      `Adapter "${adapter.id}" is missing required capabilities: ${missing.join(', ')}`,
    );
  }
}
