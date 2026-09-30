import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts/smoke-release.sh');

// On failure, surface the tail of the script's own output: the bare exit code hides
// which section of the release journey failed.
function tail(output: string, lines = 80): string {
  return output.split('\n').slice(-lines).join('\n');
}

describe.skipIf(process.env['CEV_E2E'] !== '1')('scripts/smoke-release.sh', () => {
  it('runs the keyless publish and integrate release journey and prints ok', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vetkit-release-'));
    const result = spawnSync('bash', [SCRIPT], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, VETKIT_SMOKE_DIR: join(dir, 'smoke') },
      timeout: 40 * 60 * 1000,
    });

    const diagnostics = `smoke-release.sh exited ${String(result.status)}\n--- stdout (tail) ---\n${tail(result.stdout)}\n--- stderr (tail) ---\n${tail(result.stderr)}`;

    expect(result.status, diagnostics).toBe(0);
    expect(result.stdout, diagnostics).toContain('smoke-release: ok');
  });
});
