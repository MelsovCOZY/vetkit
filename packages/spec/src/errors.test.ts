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

  test('accepts the ten judge error codes (judge port, IR validation, gate, cache)', () => {
    const j1Codes = [
      'CONFIG_INVALID',
      'CRITERIA_INVALID',
      'CASE_INVALID',
      'JUDGE_UNAVAILABLE',
      'JUDGE_TIMEOUT',
      'JUDGE_BAD_RESPONSE',
      'GATE_REFUSED',
      'CACHE_IO',
      'JUDGE_UNAUTHORIZED',
      'INPUT_TOO_LARGE',
    ] as const;

    for (const code of j1Codes) {
      expect(CEV_ERROR_CODES[code]).toBe(code);
      const err = new VetError(code, 'message');
      expect(VetError.isInstance(err)).toBe(true);
      expect(err.code).toBe(code);
    }
  });

  test('accepts the six calibration and gate codes (labels, lock staleness, gate, CLI exit mapping)', () => {
    const j3Codes = [
      'LABELS_TOO_FEW',
      'LOCK_STALE',
      'GATE_UNCALIBRATED',
      'GATE_UNPINNED',
      'NOT_INTERACTIVE',
      'UNSCORED_ONLY',
    ] as const;

    for (const code of j3Codes) {
      expect(Object.values(CEV_ERROR_CODES)).toContain(code);
      const err = new VetError(code, 'message');
      expect(VetError.isInstance(err)).toBe(true);
      expect(err.code).toBe(code);
    }
  });

  test('accepts LABELS_INVALID (malformed labels row)', () => {
    expect(CEV_ERROR_CODES.LABELS_INVALID).toBe('LABELS_INVALID');
    const err = new VetError('LABELS_INVALID', 'labels.csv:3: bad row');
    expect(VetError.isInstance(err)).toBe(true);
    expect(err.code).toBe('LABELS_INVALID');
  });

  test('accepts the five sink codes (sink/outbox)', () => {
    const sinkCodes = [
      'SINK_REJECTED',
      'SINK_UNREACHABLE',
      'SINK_AUTH',
      'SINK_PAYLOAD_TOO_LARGE',
      'OUTBOX_CORRUPT',
    ] as const;

    for (const code of sinkCodes) {
      expect(Object.values(CEV_ERROR_CODES)).toContain(code);
      const err = new VetError(code, 'message');
      expect(VetError.isInstance(err)).toBe(true);
      expect(err.code).toBe(code);
    }
  });

  test('accepts CONFIG_UNKNOWN_SINK (vet run --sink names a sink not in config)', () => {
    expect(CEV_ERROR_CODES.CONFIG_UNKNOWN_SINK).toBe('CONFIG_UNKNOWN_SINK');
    const err = new VetError('CONFIG_UNKNOWN_SINK', "unknown sink 'nope'");
    expect(VetError.isInstance(err)).toBe(true);
    expect(err.code).toBe('CONFIG_UNKNOWN_SINK');
  });

  test('accepts the five source and generator codes (source/generator)', () => {
    const j2Codes = [
      'SOURCE_UNREADABLE',
      'TRACE_INVALID',
      'GENERATOR_UNAVAILABLE',
      'GENERATOR_BAD_OUTPUT',
      'GENERATOR_CAPABILITY',
    ] as const;

    for (const code of j2Codes) {
      expect(Object.values(CEV_ERROR_CODES)).toContain(code);
      const err = new VetError(code, 'message');
      expect(VetError.isInstance(err)).toBe(true);
      expect(err.code).toBe(code);
    }
  });

  test('accepts the three OTLP codes (OTLP reader, receiver, empty source)', () => {
    const j5Codes = ['OTLP_PARSE', 'OTLP_UNSUPPORTED_CONTENT_TYPE', 'SOURCE_EMPTY'] as const;

    for (const code of j5Codes) {
      expect(CEV_ERROR_CODES[code]).toBe(code);
      const err = new VetError(code, 'message');
      expect(VetError.isInstance(err)).toBe(true);
      expect(err.code).toBe(code);
    }
  });

  test('accepts RUN_NOT_FOUND (missing run record, `vet rerun`)', () => {
    expect(CEV_ERROR_CODES.RUN_NOT_FOUND).toBe('RUN_NOT_FOUND');
    const err = new VetError('RUN_NOT_FOUND', 'no run record at .vet/runs/latest.json');
    expect(VetError.isInstance(err)).toBe(true);
    expect(err.code).toBe('RUN_NOT_FOUND');
  });

  test('accepts SOURCE_AUTH and SOURCE_UNREACHABLE (Langfuse source)', () => {
    const langfuseCodes = ['SOURCE_AUTH', 'SOURCE_UNREACHABLE'] as const;

    for (const code of langfuseCodes) {
      expect(CEV_ERROR_CODES[code]).toBe(code);
      const err = new VetError(code, 'message');
      expect(VetError.isInstance(err)).toBe(true);
      expect(err.code).toBe(code);
    }
  });

  test('accepts RECEIVER_BIND and WATCH_CONFIG (`vet watch`)', () => {
    const j7Codes = ['RECEIVER_BIND', 'WATCH_CONFIG'] as const;

    for (const code of j7Codes) {
      expect(CEV_ERROR_CODES[code]).toBe(code);
      const err = new VetError(code, 'message');
      expect(VetError.isInstance(err)).toBe(true);
      expect(err.code).toBe(code);
    }
  });

  test('accepts EXPORT_TARGET_UNKNOWN and EXPORT_NO_LOCK (`vet export`)', () => {
    const exportCodes = ['EXPORT_TARGET_UNKNOWN', 'EXPORT_NO_LOCK'] as const;

    for (const code of exportCodes) {
      expect(CEV_ERROR_CODES[code]).toBe(code);
      const err = new VetError(code, 'message');
      expect(VetError.isInstance(err)).toBe(true);
      expect(err.code).toBe(code);
    }
  });

  test('details round-trips through the constructor options', () => {
    const err = new VetError('CACHE_IO', 'cache write failed', {
      details: {
        retryable: true,
        hint: 'retry with backoff',
        retryAfterMs: 500,
        requestId: 'req-1',
      },
    });

    expect(err.details).toEqual({
      retryable: true,
      hint: 'retry with backoff',
      retryAfterMs: 500,
      requestId: 'req-1',
    });
  });

  test('details is undefined when the constructor options omit it', () => {
    const err = new VetError('CACHE_IO', 'cache write failed');

    expect(err.details).toBeUndefined();
  });
});
