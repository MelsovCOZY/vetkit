// J4 journey: `vet export --to vitest` emits files vitest runs
// unchanged, agreeing with `vet run` on every case, and a second run hits the shared cache.
// Runs scripts/smoke-j4.sh against the real Jev judge. Skipped unless CEV_E2E=1.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts/smoke-j4.sh');

function tail(output: string, lines = 40): string {
  return output.split('\n').slice(-lines).join('\n');
}

describe.skipIf(process.env['CEV_E2E'] !== '1')(
  'J4: export to vitest against the real judge',
  () => {
    it('exports, matches vet run per case, and reruns from cache with zero judge requests', () => {
      const result = spawnSync('bash', [SCRIPT], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 10 * 60 * 1000,
      });
      const diagnostics = `smoke-j4.sh exited ${String(result.status)}\n--- stdout ---\n${tail(result.stdout)}\n--- stderr ---\n${tail(result.stderr)}`;
      expect(result.status, diagnostics).toBe(0);
      expect(result.stdout, diagnostics).toContain('smoke-j4: ok');
    });
  },
);
