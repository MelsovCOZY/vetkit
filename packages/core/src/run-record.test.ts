import { mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readRunRecord, writeRunRecord, type RunRecord } from './run-record.ts';

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    results: [],
    summary: { total: 0, passed: 0, failed: 0, unscored: 0, aborted: false, byCriterion: {} },
    model: { requested: 'm', resolved: 'm-1', transport: 't', pinned: false },
    exitCode: 0,
    gateReasons: [],
    criteriaPath: '/p/evals/criteria.yaml',
    casesPath: '/p/evals/cases',
    startedAt: '2026-09-28T00:00:00.000Z',
    ...overrides,
  };
}

describe('run record (mol-p4a.16)', () => {
  it('writeRunRecord writes <cacheDir>/runs/latest.json, creating the directory', async () => {
    const cacheDir = join(mkdtempSync(join(tmpdir(), 'vetkit-rr-')), '.vet');
    await writeRunRecord(cacheDir, record());
    const text = readFileSync(join(cacheDir, 'runs', 'latest.json'), 'utf8');
    expect(text).toContain('"criteriaPath": "/p/evals/criteria.yaml"');
  });

  it('readRunRecord round-trips what writeRunRecord wrote', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'vetkit-rr-'));
    const rec = record({ exitCode: 1 });
    await writeRunRecord(cacheDir, rec);
    expect(await readRunRecord(cacheDir)).toEqual(rec);
  });

  it('readRunRecord returns null when no record exists', async () => {
    expect(await readRunRecord(mkdtempSync(join(tmpdir(), 'vetkit-rr-')))).toBeNull();
  });

  it('a second write replaces the first and leaves no temp file behind', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'vetkit-rr-'));
    await writeRunRecord(cacheDir, record({ exitCode: 0 }));
    await writeRunRecord(cacheDir, record({ exitCode: 130 }));
    expect(await readRunRecord(cacheDir)).toMatchObject({ exitCode: 130 });
    expect(readdirSync(join(cacheDir, 'runs'))).toEqual(['latest.json']);
  });

  it('readRunRecord throws on a record that is not JSON', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'vetkit-rr-'));
    mkdirSync(join(cacheDir, 'runs'));
    writeFileSync(join(cacheDir, 'runs', 'latest.json'), 'not json');
    await expect(readRunRecord(cacheDir)).rejects.toThrow();
  });

  it('readRunRecord throws on JSON that lacks results', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'vetkit-rr-'));
    mkdirSync(join(cacheDir, 'runs'));
    writeFileSync(join(cacheDir, 'runs', 'latest.json'), '{"summary":{}}');
    await expect(readRunRecord(cacheDir)).rejects.toThrow();
  });
});
