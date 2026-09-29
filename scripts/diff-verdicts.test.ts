import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

const rootDir = path.resolve(import.meta.dirname, '..');
const scriptPath = path.join(rootDir, 'scripts/diff-verdicts.mjs');
const fixturesDir = path.join(rootDir, 'fixtures/diff');

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

  test('exits 0 with 0 differences against the real vitest 5 JSON shape (space-joined fullName, no " > ")', () => {
    const { runPath, vitestPath } = writeFixtures(
      { results: [{ caseId: 'c1', criterionId: 'helpful', pass: true }] },
      {
        testResults: [
          {
            assertionResults: [
              {
                // Real vitest 5 JSON reporter output (captured from an actual run, not
                // hand-written): fullName is ancestorTitles + title, joined with a plain
                // space, never ' > '. The emitter's whole '<caseId> · <criterionId>' name
                // lives entirely in `title`.
                ancestorTitles: ['criteria.yaml'],
                fullName: 'criteria.yaml c1 · helpful',
                title: 'c1 · helpful',
                status: 'passed',
              },
            ],
          },
        ],
      },
    );
    const result = spawnSync('node', [scriptPath, runPath, vitestPath], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('differences: 0');
  });

  test('keys off title, not off splitting fullName: an extra describe level does not corrupt the id', () => {
    const { runPath, vitestPath } = writeFixtures(
      { results: [{ caseId: 'c1', criterionId: 'helpful', pass: true }] },
      {
        testResults: [
          {
            assertionResults: [
              {
                // Two ancestor levels: a fullName-splitting parse would fold "group" into
                // the caseId; title alone still carries the exact emitted name.
                ancestorTitles: ['group', 'criteria.yaml'],
                fullName: 'group criteria.yaml c1 · helpful',
                title: 'c1 · helpful',
                status: 'passed',
              },
            ],
          },
        ],
      },
    );
    const result = spawnSync('node', [scriptPath, runPath, vitestPath], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('differences: 0');
  });

  test('regenerated fixtures/diff/{run,vitest}.json (real vitest 5 shape) agree: 0 differences, exit 0', () => {
    const runPath = path.join(fixturesDir, 'run.json');
    const vitestPath = path.join(fixturesDir, 'vitest.json');
    const result = spawnSync('node', [scriptPath, runPath, vitestPath], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('differences: 0');
  });

  test('fixtures/diff/{run,vitest-mismatch}.json disagree on c2: 1 difference, exit 1', () => {
    const runPath = path.join(fixturesDir, 'run.json');
    const vitestPath = path.join(fixturesDir, 'vitest-mismatch.json');
    const result = spawnSync('node', [scriptPath, runPath, vitestPath], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('differences: 1');
  });
});
