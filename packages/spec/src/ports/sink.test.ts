import { describe, expect, test } from 'vitest';
import { VetError } from '../errors.ts';
import { verdictSchema } from '../generated/schemas.ts';
import { validateJson } from '../json.ts';
import { defineSink } from './sink.ts';
import type { SinkV1 } from './sink.ts';

function makeSink(overrides: Partial<SinkV1> = {}): SinkV1 {
  return {
    specVersion: 'v1',
    id: 'otel/logs',
    capabilities: { batch: 100, idempotent: true },
    doWrite: (batch) => Promise.resolve({ accepted: batch.map((v) => v.id ?? ''), rejected: [] }),
    ...overrides,
  };
}

function catchError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('defineSink', () => {
  test('returns a valid v1 sink unchanged (same object)', () => {
    const sink = makeSink();
    expect(defineSink(sink)).toBe(sink);
  });

  test("rejects specVersion 'v0' with E_ADAPTER_SPEC_VERSION naming the id", () => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const sink = { ...makeSink(), specVersion: 'v0' } as unknown as SinkV1;
    const caught = catchError(() => defineSink(sink));
    expect(VetError.isInstance(caught)).toBe(true);
    expect(caught).toMatchObject({
      code: 'E_ADAPTER_SPEC_VERSION',
      message: expect.stringContaining('otel/logs'),
    });
  });

  test('rejects capabilities.batch 0 with E_ADAPTER_CAPABILITY', () => {
    const caught = catchError(() =>
      defineSink(makeSink({ capabilities: { batch: 0, idempotent: true } })),
    );
    expect(VetError.isInstance(caught)).toBe(true);
    expect(caught).toMatchObject({ code: 'E_ADAPTER_CAPABILITY' });
  });

  test('rejects a non-integer capabilities.batch (1.5) with E_ADAPTER_CAPABILITY', () => {
    const caught = catchError(() =>
      defineSink(makeSink({ capabilities: { batch: 1.5, idempotent: false } })),
    );
    expect(VetError.isInstance(caught)).toBe(true);
    expect(caught).toMatchObject({ code: 'E_ADAPTER_CAPABILITY' });
  });

  test('accepts capabilities.batch 1 and an id containing a slash', () => {
    const sink = makeSink({ id: 'langfuse/scores', capabilities: { batch: 1, idempotent: false } });
    expect(defineSink(sink)).toBe(sink);
  });
});

describe('verdictSchema provenance and id', () => {
  const baseVerdict = {
    caseId: 'case-1',
    criterionId: 'promised_refund',
    status: 'ok',
    answer: { type: 'boolean', probability: 0.98 },
    model: {
      requested: 'judge-model',
      resolved: 'judge-model-2026',
      transport: 'test',
      pinned: false,
    },
    cacheHit: false,
  };

  test('a verdict with no provenance and no id still validates', () => {
    expect(validateJson(baseVerdict, verdictSchema).ok).toBe(true);
  });

  test('a verdict with an id and all six provenance fields validates', () => {
    const verdict = {
      ...baseVerdict,
      id: 'verdict-1',
      provenance: {
        traceId: '0af7651916cd43dd8448eb211c80319c',
        spanId: 'b7ad6b7169203331',
        responseId: 'resp-1',
        observationId: 'obs-1',
        dialect: 'otel-genai',
        schemaUrl: 'https://opentelemetry.io/schemas/1.37.0',
      },
    };
    expect(validateJson(verdict, verdictSchema).ok).toBe(true);
  });

  test('a verdict with spanId but no traceId is allowed by the schema', () => {
    const verdict = { ...baseVerdict, provenance: { spanId: 'b7ad6b7169203331' } };
    expect(validateJson(verdict, verdictSchema).ok).toBe(true);
  });

  test('an unknown provenance key is rejected', () => {
    const verdict = { ...baseVerdict, provenance: { traceId: 'abc', parentId: 'x' } };
    expect(validateJson(verdict, verdictSchema).ok).toBe(false);
  });

  test('a non-string provenance field is rejected', () => {
    const verdict = { ...baseVerdict, provenance: { traceId: 42 } };
    expect(validateJson(verdict, verdictSchema).ok).toBe(false);
  });
});
