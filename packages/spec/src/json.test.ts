import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, test, vi } from 'vitest';
import { VetError } from './errors.ts';
import { safeParseJson, validateJson, type JsonSchema } from './json.ts';

const personSchema: JsonSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    age: { type: 'number' },
  },
  required: ['name'],
  additionalProperties: false,
};

describe('safeParseJson', () => {
  test('returns ok:true with the parsed value for valid input', () => {
    const result = safeParseJson<{ name: string; age?: number }>(
      '{"name":"Ada","age":30}',
      personSchema,
    );

    expect(result).toEqual({ ok: true, value: { name: 'Ada', age: 30 } });
  });

  test('returns ok:false with E_JSON_PARSE for a JSON syntax error', () => {
    const result = safeParseJson('{not json', personSchema);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ok:false');
    expect(VetError.isInstance(result.error)).toBe(true);
    expect(result.error.code).toBe('E_JSON_PARSE');
  });

  test('returns ok:false with E_SCHEMA_INVALID and an instancePath for a schema violation', () => {
    const result = safeParseJson('{"age":30}', personSchema);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ok:false');
    expect(result.error.code).toBe('E_SCHEMA_INVALID');
    expect(Array.isArray(result.error.cause)).toBe(true);
    expect(result.error.cause).toEqual(
      expect.arrayContaining([expect.objectContaining({ instancePath: expect.any(String) })]),
    );
  });

  test('returns ok:false with E_JSON_PARSE for a __proto__ own key', () => {
    const result = safeParseJson('{"name":"Ada","__proto__":{"polluted":true}}', personSchema);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ok:false');
    expect(result.error.code).toBe('E_JSON_PARSE');
  });

  test('never throws, even for a JSON syntax error', () => {
    expect(() => safeParseJson('{oops', personSchema)).not.toThrow();
  });
});

describe('validateJson', () => {
  test('returns ok:false with E_JSON_PARSE for a nested __proto__ own key inside an array', () => {
    // Built with Object.defineProperty, not an object literal: `{ __proto__: x }`
    // as literal syntax sets the real prototype instead of creating an own key
    // named "__proto__" (which is what JSON.parse produces), so it would not
    // exercise the own-key scan below. Raw JSON.parse is banned outside
    // json.ts's chokepoint, so defineProperty stands in for a parsed payload.
    const nested: Record<string, unknown> = {};
    Object.defineProperty(nested, '__proto__', {
      value: { polluted: true },
      enumerable: true,
      writable: true,
      configurable: true,
    });
    const value = { name: 'Ada', tags: [nested] };

    const result = validateJson(value, {
      type: 'object',
      properties: { name: { type: 'string' }, tags: { type: 'array' } },
      additionalProperties: true,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ok:false');
    expect(result.error.code).toBe('E_JSON_PARSE');
  });

  test('accepts a valid object with no __proto__ key', () => {
    const result = validateJson({ name: 'Ada', age: 30 }, personSchema);

    expect(result).toEqual({ ok: true, value: { name: 'Ada', age: 30 } });
  });
});

describe('validateJson allErrors', () => {
  // Three violations: `name` is missing, `age` is not a number, `extra` is not allowed.
  const broken = { age: 'old', extra: 1 };

  test('allErrors: true returns every violation in the error cause', () => {
    const result = validateJson(broken, personSchema, { allErrors: true });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ok:false');
    expect(result.error.code).toBe('E_SCHEMA_INVALID');
    expect(result.error.cause).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ keyword: 'required', params: { missingProperty: 'name' } }),
        expect.objectContaining({ keyword: 'type', instancePath: '/age' }),
        expect.objectContaining({
          keyword: 'additionalProperties',
          params: { additionalProperty: 'extra' },
        }),
      ]),
    );
  });

  test('without the option validation still stops at the first violation', () => {
    const result = validateJson(broken, personSchema);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ok:false');
    expect(result.error.cause).toHaveLength(1);
  });

  test('allErrors: true accepts a valid value', () => {
    const result = validateJson({ name: 'Ada' }, personSchema, { allErrors: true });

    expect(result).toEqual({ ok: true, value: { name: 'Ada' } });
  });
});

describe('ajv singleton and validator cache', () => {
  test('compiles a schema only once across repeated calls with the same schema object', () => {
    const compileSpy = vi.spyOn(Ajv2020.prototype, 'compile');

    const schema: JsonSchema = { type: 'string' };
    safeParseJson('"a"', schema);
    safeParseJson('"b"', schema);

    expect(compileSpy).toHaveBeenCalledTimes(1);
  });
});
