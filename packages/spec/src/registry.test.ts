import { describe, expect, test } from 'vitest';
import { VetError } from './errors.ts';
import { ADAPTER_MARKER, defineAdapter, isAdapter, requireCapabilities } from './registry.ts';
import type { AdapterBase } from './registry.ts';
import { SPEC_VERSION } from './version.ts';

function makeAdapter(overrides: Partial<AdapterBase> = {}): AdapterBase {
  return {
    specVersion: SPEC_VERSION,
    id: 'acme/widget',
    kind: 'judge',
    capabilities: {},
    ...overrides,
  };
}

describe('defineAdapter', () => {
  test('returns the same object, frozen, carrying the vetkit.adapter marker', () => {
    const adapter = makeAdapter();

    const defined = defineAdapter(adapter);

    expect(defined).toBe(adapter);
    expect(Object.isFrozen(defined)).toBe(true);
    expect((defined as Record<symbol, unknown>)[ADAPTER_MARKER]).toBe(true);
  });

  test('rejects specVersion "v0" with E_ADAPTER_SPEC_VERSION naming the id and both versions', () => {
    const adapter = { ...makeAdapter(), specVersion: 'v0' } as unknown as AdapterBase;

    expect(() => defineAdapter(adapter)).toThrow(VetError);
    try {
      defineAdapter(adapter);
      throw new Error('expected defineAdapter to throw');
    } catch (err) {
      expect(VetError.isInstance(err)).toBe(true);
      expect((err as VetError).code).toBe('E_ADAPTER_SPEC_VERSION');
      expect((err as VetError).message).toContain('acme/widget');
      expect((err as VetError).message).toContain('v0');
      expect((err as VetError).message).toContain('v1');
    }
  });

  test('rejects specVersion "v2" the same way', () => {
    const adapter = { ...makeAdapter(), specVersion: 'v2' } as unknown as AdapterBase;

    expect(() => defineAdapter(adapter)).toThrow(
      expect.objectContaining({ code: 'E_ADAPTER_SPEC_VERSION' }),
    );
  });

  test('rejects an id without a "<provider>/<name>" slash with E_CONFIG', () => {
    const adapter = makeAdapter({ id: 'jev' });

    expect(() => defineAdapter(adapter)).toThrow(expect.objectContaining({ code: 'E_CONFIG' }));
  });
});

describe('isAdapter', () => {
  test('narrows a value returned by defineAdapter', () => {
    const defined = defineAdapter(makeAdapter());

    expect(isAdapter(defined)).toBe(true);
  });

  test('rejects an unmarked object, null, undefined and non-objects', () => {
    expect(isAdapter(makeAdapter())).toBe(false);
    expect(isAdapter(null)).toBe(false);
    expect(isAdapter(undefined)).toBe(false);
    expect(isAdapter('adapter')).toBe(false);
  });
});

describe('requireCapabilities', () => {
  test('passes when an array capability is a superset of the requirement', () => {
    const adapter = makeAdapter({ capabilities: { questionTypes: ['score', 'choice'] } });

    expect(() => requireCapabilities(adapter, { questionTypes: ['score'] })).not.toThrow();
  });

  test('throws E_ADAPTER_CAPABILITY listing a missing array element', () => {
    const adapter = makeAdapter({ capabilities: { questionTypes: ['choice'] } });

    try {
      requireCapabilities(adapter, { questionTypes: ['score'] });
      throw new Error('expected requireCapabilities to throw');
    } catch (err) {
      expect(VetError.isInstance(err)).toBe(true);
      expect((err as VetError).code).toBe('E_ADAPTER_CAPABILITY');
      expect((err as VetError).message).toContain('questionTypes');
    }
  });

  test('checks boolean capabilities by equality and number capabilities by >=', () => {
    const adapter = makeAdapter({ capabilities: { streaming: true, maxTokens: 4096 } });

    expect(() =>
      requireCapabilities(adapter, { streaming: true, maxTokens: 2048 }),
    ).not.toThrow();
    expect(() => requireCapabilities(adapter, { streaming: false })).toThrow(
      expect.objectContaining({ code: 'E_ADAPTER_CAPABILITY' }),
    );
    expect(() => requireCapabilities(adapter, { maxTokens: 8192 })).toThrow(
      expect.objectContaining({ code: 'E_ADAPTER_CAPABILITY' }),
    );
  });

  test('R1: a required capability present with the wrong type is unmet, listed by name, never a raw TypeError', () => {
    const adapter = makeAdapter({ capabilities: { questionTypes: true } });

    try {
      requireCapabilities(adapter, { questionTypes: ['score'] });
      throw new Error('expected requireCapabilities to throw');
    } catch (err) {
      expect(VetError.isInstance(err)).toBe(true);
      expect((err as VetError).code).toBe('E_ADAPTER_CAPABILITY');
      expect((err as VetError).message).toContain('questionTypes');
    }
  });
});
