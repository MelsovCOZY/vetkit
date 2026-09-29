// J7 journey, shell form: runs scripts/smoke-j7.sh, which builds,
// starts a real OpenTelemetry Collector in docker, runs `vet watch` against the real Jev judge
// with traffic from scripts/replay-otlp.ts, and checks every acceptance-criterion verify command.
// Skipped unless CEV_E2E=1 (key from AI_GATEWAY_API_KEY or the repo .env).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts/smoke-j7.sh');

function tail(output: string, lines = 60): string {
  return output.split('\n').slice(-lines).join('\n');
}

describe.skipIf(process.env['CEV_E2E'] !== '1')('scripts/smoke-j7.sh', () => {
  it('runs vet watch end to end and prints ok', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vetkit-e2e-j7-'));
    try {
      const result = spawnSync('bash', [SCRIPT], {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, VETKIT_SMOKE_DIR: join(dir, 'project') },
        timeout: 14 * 60 * 1000,
      });
      const diagnostics = `smoke-j7.sh exited ${String(result.status)}\n--- stdout (tail) ---\n${tail(result.stdout)}\n--- stderr (tail) ---\n${tail(result.stderr)}`;
      expect(result.status, diagnostics).toBe(0);
      expect(result.stdout, diagnostics).toContain('smoke-j7: ok');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
