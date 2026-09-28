import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts/smoke-j0.sh');

// On failure, surface the tail of the script's own stdout/stderr in the assertion
// message: the bare exit code otherwise hides which step of the clone -> check ->
// build -> pack -> consumer-matrix chain actually failed.
function tail(output: string, lines = 60): string {
  return output.split('\n').slice(-lines).join('\n');
}

describe('scripts/smoke-j0.sh', () => {
  it('clones HEAD, checks/builds/packs it and runs the consumer matrix, printing ok', () => {
    const result = spawnSync('sh', [SCRIPT], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 20 * 60 * 1000,
    });

    const diagnostics = `smoke-j0.sh exited ${String(result.status)}\n--- stdout (tail) ---\n${tail(result.stdout)}\n--- stderr (tail) ---\n${tail(result.stderr)}`;

    expect(result.status, diagnostics).toBe(0);
    expect(result.stdout, diagnostics).toContain('smoke-j0: ok');
  });
});
