import { describe, expect, test } from 'vitest';
import { flattenAnyValue, flattenAttributes, MAX_ANYVALUE_DEPTH } from './anyvalue.ts';

function nest(depth: number): Record<string, unknown> {
  let value: Record<string, unknown> = { stringValue: 'leaf' };
  for (let i = 0; i < depth; i++) value = { arrayValue: { values: [value] } };
  return value;
}

describe('flattenAnyValue', () => {
  test('flattens scalars; 64-bit intValue strings become numbers when safe', () => {
    const warnings: string[] = [];
    expect(flattenAnyValue({ stringValue: 's' }, warnings)).toBe('s');
    expect(flattenAnyValue({ boolValue: false }, warnings)).toBe(false);
    expect(flattenAnyValue({ intValue: '7' }, warnings)).toBe(7);
    expect(flattenAnyValue({ intValue: '9223372036854775807' }, warnings)).toBe(
      '9223372036854775807',
    );
    expect(flattenAnyValue({ doubleValue: 1.25 }, warnings)).toBe(1.25);
    expect(flattenAnyValue({ bytesValue: 'AAE=' }, warnings)).toBe('AAE=');
    expect(flattenAnyValue({}, warnings)).toBeNull();
    expect(warnings).toEqual([]);
  });

  test('recurses into arrayValue and kvlistValue', () => {
    const value = {
      kvlistValue: {
        values: [
          {
            key: 'list',
            value: { arrayValue: { values: [{ intValue: 1 }, { stringValue: 'two' }] } },
          },
        ],
      },
    };
    expect(flattenAnyValue(value, [])).toEqual({ list: [1, 'two'] });
  });

  test('caps nesting depth at 16 with a warning', () => {
    expect(MAX_ANYVALUE_DEPTH).toBe(16);
    const ok: string[] = [];
    expect(JSON.stringify(flattenAnyValue(nest(15), ok))).toContain('leaf');
    expect(ok).toEqual([]);

    const warnings: string[] = [];
    const deep = flattenAnyValue(nest(40), warnings);
    expect(JSON.stringify(deep)).not.toContain('leaf');
    expect(warnings.length).toBeGreaterThan(0);
  });
});

describe('flattenAttributes', () => {
  test('turns a KeyValue list into a record; the last duplicate key wins', () => {
    const attrs = [
      { key: 'a', value: { stringValue: '1' } },
      { key: 'a', value: { stringValue: '2' } },
      { key: 'b', value: { intValue: 3 } },
    ];
    expect(flattenAttributes(attrs, [])).toEqual({ a: '2', b: 3 });
  });
});
