import { describe, expect, test } from 'vitest';
import { validateJson, VetError, type JsonSchema } from '@vetkit/spec';
import { normaliseOpenAIStrict, stripNullOptionals } from './strict.ts';

function capabilityError(fn: () => unknown): VetError {
  try {
    fn();
  } catch (err) {
    if (VetError.isInstance(err)) return err;
    throw err;
  }
  throw new Error('expected a VetError');
}

const twoField: JsonSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    age: { type: 'integer' },
  },
  required: ['name'],
};

describe('normaliseOpenAIStrict', () => {
  test('sets additionalProperties false on every object', () => {
    const out = normaliseOpenAIStrict({
      type: 'object',
      properties: { inner: { type: 'object', properties: { x: { type: 'string' } } } },
      required: ['inner'],
    });
    expect(out['additionalProperties']).toBe(false);
    expect(out['properties'].inner.additionalProperties).toBe(false);
  });

  test('lists every property as required', () => {
    const out = normaliseOpenAIStrict(twoField);
    expect(out['required']).toEqual(['name', 'age']);
  });

  test('optionals become nullable unions', () => {
    const out = normaliseOpenAIStrict(twoField);
    expect(out['properties'].name).toEqual({ type: 'string' });
    expect(out['properties'].age).toEqual({ type: ['integer', 'null'] });
  });

  test('optional property without a plain type becomes an anyOf with null', () => {
    const out = normaliseOpenAIStrict({
      type: 'object',
      properties: { v: { anyOf: [{ type: 'string' }, { type: 'number' }] } },
    });
    expect(out['properties'].v).toEqual({
      anyOf: [{ anyOf: [{ type: 'string' }, { type: 'number' }] }, { type: 'null' }],
    });
  });

  test('optional enum property accepts null after normalisation', () => {
    const out = normaliseOpenAIStrict({
      type: 'object',
      properties: { kind: { type: 'string', enum: ['a', 'b'] } },
    });
    expect(validateJson({ kind: null }, out).ok).toBe(true);
    expect(validateJson({ kind: 'a' }, out).ok).toBe(true);
    expect(validateJson({ kind: 'c' }, out).ok).toBe(false);
  });

  test('nested objects and arrays normalised', () => {
    const out = normaliseOpenAIStrict({
      type: 'object',
      properties: {
        list: {
          type: 'array',
          items: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } } },
        },
      },
      required: ['list'],
      $defs: { Thing: { type: 'object', properties: { t: { type: 'string' } } } },
    });
    const item = out['properties'].list.items;
    expect(item.additionalProperties).toBe(false);
    expect(item.required).toEqual(['a', 'b']);
    expect(item.properties.b).toEqual({ type: ['number', 'null'] });
    expect(out['$defs'].Thing.additionalProperties).toBe(false);
    expect(out['$defs'].Thing.required).toEqual(['t']);
  });

  test('does not mutate input', () => {
    const input: JsonSchema = {
      type: 'object',
      properties: { a: { type: 'object', properties: { b: { type: 'string' } } } },
    };
    const snapshot = structuredClone(input);
    const out = normaliseOpenAIStrict(input);
    expect(input).toEqual(snapshot);
    expect(out).not.toBe(input);
  });

  test('map-typed object is GENERATOR_CAPABILITY naming additionalProperties', () => {
    const err = capabilityError(() =>
      normaliseOpenAIStrict({
        type: 'object',
        properties: { labels: { type: 'object', additionalProperties: { type: 'string' } } },
        required: ['labels'],
      }),
    );
    expect(err.code).toBe('GENERATOR_CAPABILITY');
    expect(err.message).toContain('additionalProperties');
  });

  test('allOf is GENERATOR_CAPABILITY naming allOf', () => {
    const err = capabilityError(() =>
      normaliseOpenAIStrict({
        type: 'object',
        properties: { a: { allOf: [{ type: 'string' }, { minLength: 1 }] } },
        required: ['a'],
      }),
    );
    expect(err.code).toBe('GENERATOR_CAPABILITY');
    expect(err.message).toContain('allOf');
  });

  test('if/then nested in a property is GENERATOR_CAPABILITY naming if', () => {
    const err = capabilityError(() =>
      normaliseOpenAIStrict({
        type: 'object',
        properties: {
          // `then` here is the JSON Schema keyword, never awaited.
          // oxlint-disable-next-line unicorn/no-thenable
          a: { type: 'string', if: { minLength: 2 }, then: { maxLength: 9 } },
        },
        required: ['a'],
      }),
    );
    expect(err.code).toBe('GENERATOR_CAPABILITY');
    expect(err.message).toContain('"if"');
  });

  test('oneOf is GENERATOR_CAPABILITY naming oneOf', () => {
    const err = capabilityError(() =>
      normaliseOpenAIStrict({
        type: 'object',
        properties: { a: { oneOf: [{ type: 'string' }, { type: 'number' }] } },
        required: ['a'],
      }),
    );
    expect(err.code).toBe('GENERATOR_CAPABILITY');
    expect(err.message).toContain('oneOf');
  });

  test('non-object root is GENERATOR_CAPABILITY', () => {
    const err = capabilityError(() => normaliseOpenAIStrict({ type: 'array', items: {} }));
    expect(err.code).toBe('GENERATOR_CAPABILITY');
    expect(err.message).toContain('root');
  });

  test('recursive $ref is GENERATOR_CAPABILITY naming $ref', () => {
    const err = capabilityError(() =>
      normaliseOpenAIStrict({
        type: 'object',
        properties: { node: { $ref: '#/$defs/Node' } },
        required: ['node'],
        $defs: {
          Node: {
            type: 'object',
            properties: { next: { $ref: '#/$defs/Node' } },
            required: ['next'],
          },
        },
      }),
    );
    expect(err.code).toBe('GENERATOR_CAPABILITY');
    expect(err.message).toContain('$ref');
  });

  test('non-recursive $ref to $defs is accepted', () => {
    const out = normaliseOpenAIStrict({
      type: 'object',
      properties: { a: { $ref: '#/$defs/A' } },
      $defs: { A: { type: 'string' } },
    });
    expect(out['properties'].a).toEqual({ anyOf: [{ $ref: '#/$defs/A' }, { type: 'null' }] });
  });
});

describe('stripNullOptionals', () => {
  test('removes null the normalisation introduced for an optional', () => {
    expect(stripNullOptionals({ name: 'x', age: null }, twoField)).toEqual({ name: 'x' });
  });

  test('keeps null on a required property', () => {
    expect(stripNullOptionals({ name: null }, twoField)).toEqual({ name: null });
  });

  test('explicit nullable optional keeps null', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: { note: { type: ['string', 'null'] }, kind: { enum: ['a', null] } },
    };
    expect(stripNullOptionals({ note: null, kind: null }, schema)).toEqual({
      note: null,
      kind: null,
    });
  });

  test('strips nested optionals inside arrays and $defs', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        list: { type: 'array', items: { $ref: '#/$defs/Item' } },
      },
      required: ['list'],
      $defs: {
        Item: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } } },
      },
    };
    expect(stripNullOptionals({ list: [{ a: 'x', b: null }] }, schema)).toEqual({
      list: [{ a: 'x' }],
    });
  });

  test('does not mutate the value', () => {
    const value = { name: 'x', age: null };
    stripNullOptionals(value, twoField);
    expect(value).toEqual({ name: 'x', age: null });
  });
});
