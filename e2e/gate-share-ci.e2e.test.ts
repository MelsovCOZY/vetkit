// Gate journey, shell form: runs scripts/smoke-gate-share-ci.sh, one pass over the built CLI and
// the action scripts with an in-process fake judge: the report/badge/run-record a developer can
// paste, the path from an uncalibrated label to the calibrated gate (with offline record and
// replay), and the one-snippet CI journey (install, run, annotations, summary, sticky comment).
// No key, no network, no GitHub. Skipped unless CEV_E2E=1; the build runs first (`bun run build`).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts/smoke-gate-share-ci.sh');

function tail(output: string, lines = 80): string {
  return output.split('\n').slice(-lines).join('\n');
}

describe.skipIf(process.env['CEV_E2E'] !== '1')('scripts/smoke-gate-share-ci.sh', () => {
  it('walks the share, gate and CI journeys and prints ok', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vetkit-e2e-gate-share-ci-'));
    try {
      const result = spawnSync('bash', [SCRIPT], {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, VETKIT_SMOKE_DIR: join(dir, 'smoke') },
        timeout: 14 * 60 * 1000,
      });
      const diagnostics = `smoke-gate-share-ci.sh exited ${String(result.status)}\n--- stdout (tail) ---\n${tail(result.stdout)}\n--- stderr (tail) ---\n${tail(result.stderr)}`;
      expect(result.status, diagnostics).toBe(0);
      expect(result.stdout, diagnostics).toContain('smoke-gate-share-ci: ok');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
