import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { writeReports } from './junit.ts';

const SECRET = `k&y<9>"x'1`;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('writeReports redaction of XML-special secrets', () => {
  test('secret with xml-special chars is redacted in junit', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', SECRET);
    const dir = await mkdtemp(join(tmpdir(), 'vetkit-junit-escape-'));
    const path = await writeReports(
      { kind: 'junit', path: 'out/junit.xml' },
      [
        {
          criteriaPath: 'evals/criteria.yaml',
          result: {
            results: [],
            model: {
              requested: `m-${SECRET}`,
              resolved: SECRET,
              transport: 'fake',
              pinned: false,
            },
          },
        },
      ],
      { cwd: dir },
    );
    const xml = await readFile(path ?? '', 'utf8');
    expect(xml).not.toContain(SECRET);
    expect(xml).not.toContain('k&amp;y&lt;9&gt;&quot;x&apos;1');
    expect(xml).not.toContain('k&amp;y');
    expect(xml).toContain('[redacted]');
  });
});
