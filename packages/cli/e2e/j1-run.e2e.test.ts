// J1 journey (bd classified-evals-mol-n5w): `vet run` judges one case against the REAL Jev
// judge and its exit code is usable in CI. Runs scripts/smoke-j1.sh, which builds, writes a
// scratch project and checks every acceptance-criterion verify command.
//
// Final cold gate only: skipped unless CEV_E2E=1 (the key comes from AI_GATEWAY_API_KEY or
// the repo .env; see the script). Two live judge requests per run.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const SCRIPT = join(ROOT, 'scripts/smoke-j1.sh');

function tail(output: string, lines = 40): string {
  return output.split('\n').slice(-lines).join('\n');
}

describe.skipIf(process.env['CEV_E2E'] !== '1')('J1: vet run against the real judge', () => {
  it('judges one case: verdict ok, cache hit on rerun, exit 1 on fail, exit 2 on --gate', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vetkit-e2e-j1-'));
    try {
      const result = spawnSync('bash', [SCRIPT], {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, VETKIT_SMOKE_DIR: join(dir, 'project') },
        timeout: 10 * 60 * 1000,
      });
      const diagnostics = `smoke-j1.sh exited ${String(result.status)}\n--- stdout ---\n${tail(result.stdout)}\n--- stderr ---\n${tail(result.stderr)}`;
      expect(result.status, diagnostics).toBe(0);
      expect(result.stdout, diagnostics).toContain('smoke-j1: ok');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
