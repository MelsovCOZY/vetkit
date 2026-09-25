import { describe, expect, test, vi } from 'vitest';
import { CEV_ERROR_CODES, VetError } from './errors.ts';

describe('VetError', () => {
  test('carries the code, message and cause given to the constructor', () => {
    const cause = new Error('root cause');

    const err = new VetError('E_CONFIG', 'bad config', { cause });

    expect(err.code).toBe('E_CONFIG');
    expect(err.message).toBe('bad config');
    expect(err.cause).toBe(cause);
  });

  test('is an instance of Error', () => {
    const err = new VetError('E_CONFIG', 'bad config');

    expect(err instanceof Error).toBe(true);
  });

  test('CEV_ERROR_CODES lists every code accepted by the constructor', () => {
    for (const code of Object.values(CEV_ERROR_CODES)) {
      const err = new VetError(code, 'message');
      expect(err.code).toBe(code);
    }
  });

  test('VetError.isInstance recognizes an instance from a second copy of the module', async () => {
    const mod1 = await import('./errors.ts');
    vi.resetModules();
    const mod2 = await import('./errors.ts');

    const instance = new mod1.VetError('E_CONFIG', 'bad config');

    expect(mod1.VetError).not.toBe(mod2.VetError);
    expect(instance instanceof mod2.VetError).toBe(false);
    expect(mod2.VetError.isInstance(instance)).toBe(true);
  });

  test('VetError.isInstance returns false for values without the marker', () => {
    expect(VetError.isInstance(new Error('plain'))).toBe(false);
    expect(VetError.isInstance({ code: 'E_CONFIG' })).toBe(false);
    expect(VetError.isInstance(null)).toBe(false);
    expect(VetError.isInstance(undefined)).toBe(false);
  });
});
