import type { Verdict } from '@vetkit/spec';
import { describe, expect, test } from 'vitest';
import { type OtlpAttribute } from './encode.ts';
import { verdictToSpan } from './encode-span.ts';

const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const SPAN_ID = 'b7ad6b7169203331';

function verdict(overrides: Partial<Verdict> = {}): Verdict {
  return {
    caseId: 'case-1',
    criterionId: 'promised_refund',
    status: 'unscored',
    model: { requested: 'judge', resolved: 'judge-2026', transport: 'test', pinned: false },
    cacheHit: false,
    provenance: { traceId: TRACE_ID, spanId: SPAN_ID },
    ...overrides,
  };
}

function attr(attributes: OtlpAttribute[], key: string): OtlpAttribute['value'] | undefined {
  return attributes.find((a) => a.key === key)?.value;
}

describe('verdictToSpan error.type', () => {
  test('a string cause is used as error.type', () => {
    const span = verdictToSpan(verdict({ cause: 'JUDGE_UNAVAILABLE' }));
    expect(attr(span.attributes, 'error.type')).toEqual({ stringValue: 'JUDGE_UNAVAILABLE' });
  });

  test('an object cause.code is used as error.type', () => {
    const span = verdictToSpan(
      verdict({ cause: { code: 'JUDGE_TIMEOUT', status: 0, errorType: 'timeout' } }),
    );
    expect(attr(span.attributes, 'error.type')).toEqual({ stringValue: 'JUDGE_TIMEOUT' });
  });

  test('falls back to the status when the cause has no code', () => {
    const span = verdictToSpan(verdict({ cause: undefined }));
    expect(attr(span.attributes, 'error.type')).toEqual({ stringValue: 'unscored' });
  });

  test('no score attributes are emitted on failure', () => {
    const span = verdictToSpan(verdict({ cause: 'JUDGE_UNAVAILABLE' }));
    expect(attr(span.attributes, 'evaluations.0.evaluation.score')).toBeUndefined();
  });
});
