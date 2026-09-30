// safeParseJson(text, schema) is the one JSON.parse chokepoint under packages/*/src
// (scripts/ban-raw-json-parse.sh excludes exactly this file). ajv@8 in 2020-12 mode
// is compiled from 'ajv/dist/2020.js' (not the default 'ajv/dist/2020' specifier:
// this package has no "exports" map, so under Node's ESM resolution the subpath
// import needs an explicit extension; imported as a named export, not the default,
// because the default export's .d.ts is authored assuming esModuleInterop, which
// this tsconfig does not set - a default import type-checks as the whole module
// namespace instead of the Ajv2020 class, and loses its construct signature).
import { Ajv2020, type SchemaObject, type ValidateFunction } from 'ajv/dist/2020.js';
import { CEV_ERROR_CODES, VetError } from './errors.ts';

export type JsonSchema = SchemaObject;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: VetError };

export interface ValidateJsonOptions {
  /**
   * Collect every violation instead of stopping at the first. For files a developer
   * writes by hand, where one pass should list everything to fix; leave it off for
   * payloads from the network (ajv advises against allErrors on untrusted input).
   */
  readonly allErrors?: boolean;
}

interface Compiler {
  readonly ajv: Ajv2020;
  readonly cache: WeakMap<JsonSchema, ValidateFunction>;
}

const firstError: Compiler = {
  ajv: new Ajv2020({ strict: true, allErrors: false }),
  cache: new WeakMap(),
};
const everyError: Compiler = {
  ajv: new Ajv2020({ strict: true, allErrors: true }),
  cache: new WeakMap(),
};

function getValidator(schema: JsonSchema, { ajv, cache }: Compiler): ValidateFunction {
  const cached = cache.get(schema);
  if (cached) return cached;

  let validator: ValidateFunction;
  try {
    validator = ajv.compile(schema);
  } catch (cause) {
    throw new VetError(CEV_ERROR_CODES.E_SCHEMA_INVALID, 'Invalid JSON schema', { cause });
  }
  cache.set(schema, validator);
  return validator;
}

// Own `__proto__` keys survive JSON.parse as plain data properties (JSON.parse
// uses CreateDataProperty, not assignment), so `Object.hasOwn` sees them without
// touching the prototype chain; `in` is never used here because it would also
// match an inherited `__proto__` accessor. ajv's `strict` mode does not reject
// these keys (ajv security page), so they are rejected after parse instead.
function hasProtoPollutionKey(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(hasProtoPollutionKey);
  }
  if (typeof value === 'object' && value !== null) {
    if (Object.hasOwn(value, '__proto__')) return true;
    return Object.values(value).some(hasProtoPollutionKey);
  }
  return false;
}

export function validateJson<T>(
  value: unknown,
  schema: JsonSchema,
  options: ValidateJsonOptions = {},
): ParseResult<T> {
  if (hasProtoPollutionKey(value)) {
    return {
      ok: false,
      error: new VetError(CEV_ERROR_CODES.E_JSON_PARSE, 'Rejected __proto__ own key'),
    };
  }

  const validate = getValidator(schema, options.allErrors === true ? everyError : firstError);
  if (validate(value)) {
    // schema is a plain JsonSchema (not JSONSchemaType<T>), so ajv cannot tie the
    // validated shape to T; this is the trusted boundary assertion.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return { ok: true, value: value as T };
  }
  return {
    ok: false,
    error: new VetError(CEV_ERROR_CODES.E_SCHEMA_INVALID, 'JSON schema validation failed', {
      cause: validate.errors,
    }),
  };
}

export function safeParseJson<T>(text: string, schema: JsonSchema): ParseResult<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    return {
      ok: false,
      error: new VetError(CEV_ERROR_CODES.E_JSON_PARSE, 'Invalid JSON', { cause }),
    };
  }
  return validateJson<T>(parsed, schema);
}
