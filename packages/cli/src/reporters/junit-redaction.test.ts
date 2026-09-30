import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { writeReports } from './junit.ts';

const CANARY = 'canary-Key-9f8e7d6c5b4a';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('writeReports redaction', () => {
  test('the JUnit file never contains an env secret that reached the model fields', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', CANARY);
    const dir = await mkdtemp(join(tmpdir(), 'vetkit-junit-redact-'));
    const path = await writeReports(
      { kind: 'junit', path: 'out/junit.xml' },
      [
        {
          criteriaPath: 'evals/criteria.yaml',
          result: {
            results: [],
            model: {
              requested: `m-${CANARY}`,
              resolved: CANARY,
              transport: 'fake',
              pinned: false,
            },
          },
        },
      ],
      { cwd: dir },
    );
    const xml = await readFile(path ?? '', 'utf8');
    expect(xml).not.toContain(CANARY);
    expect(xml).toContain('<testsuites');
  });
});
