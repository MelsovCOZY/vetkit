import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRecordSchema, safeParseJson, validateJson, VetError } from '@vetkit/spec';
import { describe, expect, it } from 'vitest';
import { readRunRecord, writeRunRecord, type RunRecord } from './run-record.ts';

function record(overrides: Partial<Omit<RunRecord, '$schema'>> = {}): Omit<RunRecord, '$schema'> {
  return {
    results: [],
    summary: { total: 0, passed: 0, failed: 0, unscored: 0, aborted: false, byCriterion: {} },
    model: { requested: 'm', resolved: 'm-1', transport: 't', pinned: false },
    exitCode: 0,
    gateReasons: [],
    criteriaPath: 'evals/criteria.yaml',
    casesPath: 'evals/cases',
    startedAt: '2026-09-28T00:00:00.000Z',
    gateRequested: false,
    ...overrides,
  };
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'vetkit-rr-'));
}

function parseObject(text: string): Record<string, unknown> {
  const result = safeParseJson<Record<string, unknown>>(text, { type: 'object' });
  if (!result.ok) throw result.error;
  return result.value;
}

describe('run record', () => {
  it('writeRunRecord writes runs/<stamp>.json and a byte-identical runs/latest.json', async () => {
    const cacheDir = join(tmp(), '.vet');
    const { path, latestPath } = await writeRunRecord(cacheDir, record());
    expect(path).toBe(join(cacheDir, 'runs', '2026-09-28T00-00-00-000Z.json'));
    expect(latestPath).toBe(join(cacheDir, 'runs', 'latest.json'));
    const perRun = readFileSync(path);
    expect(readFileSync(latestPath).equals(perRun)).toBe(true);
    expect(readdirSync(join(cacheDir, 'runs')).toSorted()).toEqual([
      '2026-09-28T00-00-00-000Z.json',
      'latest.json',
    ]);
  });

  it("the stamp is startedAt with ':' and '.' replaced by '-'", async () => {
    const { path } = await writeRunRecord(
      tmp(),
      record({ startedAt: '2026-09-30T12:34:56.789+02:00' }),
    );
    expect(path.endsWith(join('runs', '2026-09-30T12-34-56-789+02-00.json'))).toBe(true);
    expect(existsSync(path)).toBe(true);
  });

  it("the written record's first key is $schema and equals runRecordSchema.$id", async () => {
    const { latestPath } = await writeRunRecord(tmp(), record());
    const doc = parseObject(readFileSync(latestPath, 'utf8'));
    expect(Object.keys(doc)[0]).toBe('$schema');
    expect(doc['$schema']).toBe(runRecordSchema.$id);
  });

  it('a second run leaves both per-run files and latest.json equals the newer one', async () => {
    const cacheDir = tmp();
    const first = await writeRunRecord(cacheDir, record({ startedAt: '2026-09-28T00:00:00.000Z' }));
    const second = await writeRunRecord(
      cacheDir,
      record({ startedAt: '2026-09-28T00:00:01.000Z', exitCode: 1 }),
    );
    expect(existsSync(first.path)).toBe(true);
    expect(existsSync(second.path)).toBe(true);
    expect(readFileSync(second.latestPath).equals(readFileSync(second.path))).toBe(true);
    expect(readFileSync(second.latestPath).equals(readFileSync(first.path))).toBe(false);
    expect(readdirSync(join(cacheDir, 'runs')).some((f) => f.endsWith('.tmp'))).toBe(false);
  });

  it('readRunRecord round-trips what writeRunRecord wrote, hook extras included', async () => {
    const cacheDir = tmp();
    const rec = { ...record({ exitCode: 1 }), sinks: { otel: 2 }, outbox: { pending: 0 } };
    await writeRunRecord(cacheDir, rec);
    expect(await readRunRecord(cacheDir)).toEqual({ $schema: runRecordSchema.$id, ...rec });
  });

  it('readRunRecord returns null when no record exists', async () => {
    expect(await readRunRecord(tmp())).toBeNull();
  });

  it('an absolute criteriaPath is refused with E_SCHEMA_INVALID and nothing is written (no file, no .tmp)', async () => {
    const cacheDir = join(tmp(), '.vet');
    const error = await writeRunRecord(cacheDir, record({ criteriaPath: '/p/evals/criteria.yaml' }))
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect(VetError.isInstance(error) && error.code).toBe('E_SCHEMA_INVALID');
    expect(existsSync(cacheDir)).toBe(false);
  });

  it('a drive-letter casesPath (C:\\…) is refused', async () => {
    const cacheDir = tmp();
    const error = await writeRunRecord(cacheDir, record({ casesPath: 'C:\\p\\evals\\cases' }))
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect(VetError.isInstance(error) && error.code).toBe('E_SCHEMA_INVALID');
    expect(existsSync(join(cacheDir, 'runs'))).toBe(false);
  });

  it('a latest.json without $schema makes readRunRecord throw a message that names `vet run`', async () => {
    const cacheDir = tmp();
    mkdirSync(join(cacheDir, 'runs'));
    writeFileSync(join(cacheDir, 'runs', 'latest.json'), JSON.stringify(record()));
    const error = await readRunRecord(cacheDir).catch((e: unknown) => e);
    expect(error instanceof Error && error.message).toMatch(
      /run `vet run` to write a current record$/,
    );
  });

  it('runRecordSchema accepts a minimal portable record and additional properties', () => {
    const doc = { $schema: runRecordSchema.$id, ...record(), extra: { anything: 1 } };
    expect(validateJson(doc, runRecordSchema).ok).toBe(true);
  });
});
