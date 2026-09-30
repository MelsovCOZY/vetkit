import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { writeRunRecord, type RunRecord } from './run-record.ts';

const CANARY = 'canary-Key-9f8e7d6c5b4a';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('writeRunRecord redaction', () => {
  test('the persisted record never contains an env secret and stays valid JSON', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', CANARY);
    const dir = await mkdtemp(join(tmpdir(), 'vetkit-record-redact-'));
    const record = {
      results: [],
      summary: { passed: 0, failed: 0, unscored: 0 },
      model: { requested: 'm', resolved: CANARY, transport: 'fake', pinned: false },
      criteriaPath: `evals/${CANARY}.yaml`,
      casesPath: 'evals/cases',
      startedAt: '2026-01-01T00:00:00.000Z',
    } as unknown as RunRecord;
    await writeRunRecord(dir, record);
    const text = await readFile(join(dir, 'runs', 'latest.json'), 'utf8');
    expect(text).not.toContain(CANARY);
    expect(JSON.parse(text)).toMatchObject({ startedAt: '2026-01-01T00:00:00.000Z' });
  });
});
