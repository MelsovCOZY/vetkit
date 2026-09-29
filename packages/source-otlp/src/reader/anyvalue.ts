// OTLP AnyValue / KeyValue flattening. AnyValue nests through arrayValue and
// kvlistValue, so the flattener recurses and caps depth at MAX_ANYVALUE_DEPTH, replacing anything
// deeper with null and recording a warning (RISK note on the bead).

export const MAX_ANYVALUE_DEPTH = 16;

// The flattened, plain-JSON form of an OTLP AnyValue.
export type AnyValue = string | number | boolean | null | AnyValue[] | { [key: string]: AnyValue };

// Wire shapes as validated by otlp.schema.json.
export interface RawAnyValue {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string | number;
  doubleValue?: number | string;
  bytesValue?: string;
  arrayValue?: { values?: RawAnyValue[] };
  kvlistValue?: { values?: RawKeyValue[] };
}

export interface RawKeyValue {
  key: string;
  value?: RawAnyValue;
}

function flattenInt(value: string | number): number | string {
  if (typeof value === 'number') return value;
  const n = Number(value);
  // A 64-bit value beyond 2^53 keeps its exact decimal string rather than losing precision.
  return Number.isSafeInteger(n) ? n : value;
}

function flattenAt(value: RawAnyValue, depth: number, warnings: string[]): AnyValue {
  if (depth >= MAX_ANYVALUE_DEPTH) {
    warnings.push(`AnyValue nested deeper than ${MAX_ANYVALUE_DEPTH} levels; replaced with null`);
    return null;
  }
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.boolValue !== undefined) return value.boolValue;
  if (value.intValue !== undefined) return flattenInt(value.intValue);
  if (value.doubleValue !== undefined) return value.doubleValue;
  if (value.bytesValue !== undefined) return value.bytesValue;
  if (value.arrayValue !== undefined) {
    return (value.arrayValue.values ?? []).map((v) => flattenAt(v, depth + 1, warnings));
  }
  if (value.kvlistValue !== undefined) {
    return kvAt(value.kvlistValue.values ?? [], depth + 1, warnings);
  }
  return null;
}

function kvAt(list: RawKeyValue[], depth: number, warnings: string[]): Record<string, AnyValue> {
  const out: Record<string, AnyValue> = {};
  for (const kv of list) {
    // Keys are data: defineProperty keeps a `__proto__` key an own property, never a prototype set.
    Object.defineProperty(out, kv.key, {
      value: kv.value === undefined ? null : flattenAt(kv.value, depth, warnings),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

export function flattenAnyValue(value: RawAnyValue, warnings: string[]): AnyValue {
  return flattenAt(value, 0, warnings);
}

// A KeyValue list becomes a record; a repeated key keeps its last value.
export function flattenAttributes(
  list: readonly RawKeyValue[] | undefined,
  warnings: string[],
): Record<string, AnyValue> {
  return kvAt([...(list ?? [])], 0, warnings);
}
