import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, test } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// The action's tests run under `node --test`, outside vitest, so the one-temp-root-per-run
// global setup does not cover them: they have to remove their own scratch. Here they run with a
// temp dir and a runner temp dir of their own, and both must be empty once they are done.
describe('the node action tests remove their own scratch', () => {
  const base = mkdtempSync(join(tmpdir(), 'vetkit-action-tests-'));
  const temp = join(base, 'tmp');
  const runnerTemp = join(base, 'runner');
  let run: { status: number | null; stdout: string; stderr: string };

  beforeAll(() => {
    mkdirSync(temp);
    mkdirSync(runnerTemp);
    run = spawnSync('node', ['--test', 'action/run.test.mjs', 'action/comment.test.mjs'], {
      cwd: repoRoot,
      env: { ...process.env, TMPDIR: temp, TMP: temp, TEMP: temp, RUNNER_TEMP: runnerTemp },
      encoding: 'utf8',
    });
  }, 60_000);

  test('the run passes', () => {
    expect(run.status, run.stdout + run.stderr).toBe(0);
  });

  test('nothing is left in the temp dir', () => {
    expect(readdirSync(temp)).toEqual([]);
  });

  test('nothing is left in the runner temp dir', () => {
    expect(readdirSync(runnerTemp)).toEqual([]);
  });
});
