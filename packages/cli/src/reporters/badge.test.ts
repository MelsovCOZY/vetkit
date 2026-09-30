import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunRecord } from '@vetkit/core';
import { safeParseJson, type Criterion, type Lock } from '@vetkit/spec';
import { describe, expect, test } from 'vitest';
import { BADGE_FILE, badgeJson, writeBadge } from './badge.ts';
import { buildReportModel, type ReportModel } from './report.ts';

const fixtures = fileURLToPath(new URL('../../../../fixtures/reporters/', import.meta.url));

function criterion(id: string): Criterion {
  return {
    id,
    type: 'boolean',
    instructions: `Is ${id} ok?`,
    escape: 'none',
    polarity: 'pass_when_true',
    channel: 'quality',
    provenance: { traceIds: [] },
    wordingHash: `hash-${id}`,
  };
}

function calibratedLock(id: string): Lock {
  const pass = 'pass' as const;
  return {
    lockVersion: 1,
    model: { requested: 'm', resolved: 'm', transport: 't', pinned: true },
    datasetHash: 'd'.repeat(64),
    criteria: {
      [id]: {
        wordingHash: `hash-${id}`,
        status: 'calibrated',
        threshold: 0.7,
        gauntlet: {
          paraphrase: pass,
          polarity: pass,
          injection: pass,
          master_key: pass,
          label_permutation: pass,
          constant_output: pass,
          position_swap: pass,
          length: pass,
        },
        reasons: [],
        labelCount: 12,
      },
    },
  };
}

function model(exitCode: number, gateRequested: boolean, calibrated: boolean): ReportModel {
  const parsed = safeParseJson<RunRecord>(readFileSync(join(fixtures, 'run.json'), 'utf8'), {});
  if (!parsed.ok) throw parsed.error;
  return buildReportModel({
    record: {
      ...parsed.value,
      $schema: 'https://example.test/run-record.schema.json',
      criteriaPath: 'evals/criteria.yaml',
      casesPath: 'evals/cases',
      startedAt: '2026-09-30T10:00:00.000Z',
      gateRequested,
      exitCode,
    },
    criteria: [criterion('polite')],
    lock: calibrated ? calibratedLock('polite') : null,
    includeCases: false,
    vetkitVersion: '9.9.9',
    env: {},
  });
}

describe('badgeJson', () => {
  test('badgeJson has exactly schemaVersion, label, message, color in that order and schemaVersion === 1', () => {
    const text = badgeJson(model(1, false, false));
    expect(text.endsWith('}\n')).toBe(true);
    expect(text).toContain('\n  "schemaVersion": 1,');
    const parsed = safeParseJson<Record<string, unknown>>(text, {});
    if (!parsed.ok) throw parsed.error;
    expect(Object.keys(parsed.value)).toEqual(['schemaVersion', 'label', 'message', 'color']);
    expect(parsed.value).toEqual({
      schemaVersion: 1,
      label: 'vetkit',
      message: 'uncalibrated · fail',
      color: 'red',
    });
  });

  test('message is non-empty and contains neither a percentage nor a passed/total count for every exitCode × gateRequested × calibration combination', () => {
    for (const exitCode of [0, 1, 2, 3, 130]) {
      for (const gateRequested of [false, true]) {
        for (const calibrated of [false, true]) {
          const parsed = safeParseJson<{ message: string }>(
            badgeJson(model(exitCode, gateRequested, calibrated)),
            {},
          );
          if (!parsed.ok) throw parsed.error;
          const { message } = parsed.value;
          expect(message.length).toBeGreaterThan(0);
          expect(message).not.toMatch(/%|passed/);
          // The only N/M allowed is the calibrated count, always followed by the word calibrated.
          expect(message.replaceAll(/\d+\/\d+ calibrated/g, '')).not.toMatch(/\d+\s*\/\s*\d+/);
        }
      }
    }
  });
});

describe('writeBadge', () => {
  test('writeBadge writes <cacheDir>/badge.json atomically and returns its path', async () => {
    const cacheDir = join(mkdtempSync(join(tmpdir(), 'vetkit-badge-')), 'nested', '.vet');
    const m = model(0, false, false);
    const path = await writeBadge(cacheDir, m);
    expect(BADGE_FILE).toBe('badge.json');
    expect(path).toBe(join(cacheDir, 'badge.json'));
    expect(readFileSync(path, 'utf8')).toBe(badgeJson(m));
    expect(readdirSync(cacheDir)).toEqual(['badge.json']);
  });
});
