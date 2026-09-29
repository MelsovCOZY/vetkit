import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

const rootDir = path.resolve(import.meta.dirname, '..');
const scriptPath = path.join(rootDir, 'scripts/diff-verdicts.mjs');

const cleanupDirs: string[] = [];

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writeFixtures(run: unknown, vitest: unknown): { runPath: string; vitestPath: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'vetkit-diff-verdicts-'));
  cleanupDirs.push(dir);
  const runPath = path.join(dir, 'run.json');
  const vitestPath = path.join(dir, 'vitest.json');
  writeFileSync(runPath, JSON.stringify(run), 'utf8');
  writeFileSync(vitestPath, JSON.stringify(vitest), 'utf8');
  return { runPath, vitestPath };
}

describe('diff-verdicts.mjs', () => {
  test('fails (non-zero exit) when the compared set is empty, instead of reporting 0 differences', () => {
    const { runPath, vitestPath } = writeFixtures({ results: [] }, { testResults: [] });
    const result = spawnSync('node', [scriptPath, runPath, vitestPath], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain('differences: 0');
  });

  test('exits 0 with 0 differences when run and vitest verdicts agree', () => {
    const { runPath, vitestPath } = writeFixtures(
      { results: [{ caseId: 'c1', criterionId: 'helpful', pass: true }] },
      {
        testResults: [
          {
            assertionResults: [
              { status: 'passed', fullName: 'evals/criteria.yaml > c1 · helpful' },
            ],
          },
        ],
      },
    );
    const result = spawnSync('node', [scriptPath, runPath, vitestPath], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('differences: 0');
  });
});
