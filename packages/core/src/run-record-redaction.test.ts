import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { safeParseJson } from '@vetkit/spec';
import { writeRunRecord, type RunRecord } from './run-record.ts';

const CANARY = 'canary-Key-9f8e7d6c5b4a';

function parseJson(text: string): unknown {
  const result = safeParseJson<unknown>(text, {});
  if (!result.ok) throw result.error;
  return result.value;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('writeRunRecord redaction', () => {
  test('the persisted record never contains an env secret and stays valid JSON', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', CANARY);
    const dir = await mkdtemp(join(tmpdir(), 'vetkit-record-redact-'));
    const record: RunRecord = {
      results: [],
      summary: { total: 0, passed: 0, failed: 0, unscored: 0, aborted: false, byCriterion: {} },
      model: { requested: 'm', resolved: CANARY, transport: 'fake', pinned: false },
      exitCode: 0,
      gateReasons: [],
      $schema: 'https://melsovcozy.github.io/vetkit/schemas/run-record.schema.json',
      gateRequested: false,
      criteriaPath: `evals/${CANARY}.yaml`,
      casesPath: 'evals/cases',
      startedAt: '2026-01-01T00:00:00.000Z',
    };
    await writeRunRecord(dir, record);
    const text = await readFile(join(dir, 'runs', 'latest.json'), 'utf8');
    expect(text).not.toContain(CANARY);
    expect(parseJson(text)).toMatchObject({ startedAt: '2026-01-01T00:00:00.000Z' });
  });
});
