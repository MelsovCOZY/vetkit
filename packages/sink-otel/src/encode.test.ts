import type { Verdict } from '@vetkit/spec';
import { describe, expect, test } from 'vitest';
import { type OtlpAttribute, VETKIT_ATTR, verdictToLogRecord } from './encode.ts';

function verdict(overrides: Partial<Verdict> = {}): Verdict {
  return {
    caseId: 'case-1',
    criterionId: 'promised_refund',
    status: 'unscored',
    model: { requested: 'judge', resolved: 'judge-2026', transport: 'test', pinned: false },
    cacheHit: false,
    ...overrides,
  };
}

function attr(attributes: OtlpAttribute[], key: string): OtlpAttribute['value'] | undefined {
  return attributes.find((a) => a.key === key)?.value;
}

describe('verdictToLogRecord error.type', () => {
  test('a string cause is used as error.type', () => {
    const rec = verdictToLogRecord(verdict({ cause: 'JUDGE_UNAVAILABLE' }));
    expect(attr(rec.attributes, 'error.type')).toEqual({ stringValue: 'JUDGE_UNAVAILABLE' });
  });

  test('an object cause.code is used as error.type', () => {
    const rec = verdictToLogRecord(
      verdict({ cause: { code: 'JUDGE_TIMEOUT', status: 0, errorType: 'timeout' } }),
    );
    expect(attr(rec.attributes, 'error.type')).toEqual({ stringValue: 'JUDGE_TIMEOUT' });
  });

  test('falls back to the status when the cause has no code', () => {
    const rec = verdictToLogRecord(verdict({ cause: undefined }));
    expect(attr(rec.attributes, 'error.type')).toEqual({ stringValue: 'unscored' });
  });

  test('no score attributes are emitted on failure', () => {
    const rec = verdictToLogRecord(verdict({ cause: 'JUDGE_UNAVAILABLE' }));
    expect(attr(rec.attributes, 'gen_ai.evaluation.score.value')).toBeUndefined();
    expect(attr(rec.attributes, 'gen_ai.evaluation.score.label')).toBeUndefined();
  });
});

describe('vetkit namespace', () => {
  test('log record extension attributes use the vetkit. namespace', () => {
    const rec = verdictToLogRecord(
      verdict({
        model: { requested: 'judge', resolved: 'judge-2026', transport: 'test', pinned: true },
        cacheHit: true,
      }),
    );
    expect(attr(rec.attributes, 'vetkit.model.resolved')).toEqual({ stringValue: 'judge-2026' });
    expect(attr(rec.attributes, 'vetkit.model.transport')).toEqual({ stringValue: 'test' });
    expect(attr(rec.attributes, 'vetkit.model.pinned')).toEqual({ boolValue: true });
    expect(attr(rec.attributes, 'vetkit.cache_hit')).toEqual({ boolValue: true });
    expect(
      rec.attributes.filter((a) => a.key.startsWith(`${['classified', 'evals'].join('_')}.`)),
    ).toEqual([]);
  });

  test('VETKIT_ATTR lists the four extension keys', () => {
    expect(VETKIT_ATTR).toEqual({
      modelResolved: 'vetkit.model.resolved',
      modelTransport: 'vetkit.model.transport',
      modelPinned: 'vetkit.model.pinned',
      cacheHit: 'vetkit.cache_hit',
    });
  });
});
