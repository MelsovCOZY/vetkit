import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts/smoke-j5.sh');

// On failure, surface the tail of the script's own stdout/stderr in the assertion message:
// the bare exit code otherwise hides which AC line (five-dialect diff, tokens, exclusion
// counts, receiver) actually failed.
function tail(output: string, lines = 80): string {
  return output.split('\n').slice(-lines).join('\n');
}

describe('scripts/smoke-j5.sh', () => {
  it('runs every J5 acceptance-criterion verify command against in-process fake adapters and prints ok', () => {
    const result = spawnSync('sh', [SCRIPT], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 5 * 60 * 1000,
    });

    const diagnostics = `smoke-j5.sh exited ${String(result.status)}\n--- stdout (tail) ---\n${tail(result.stdout)}\n--- stderr (tail) ---\n${tail(result.stderr)}`;

    expect(result.status, diagnostics).toBe(0);
    expect(result.stdout, diagnostics).toContain('smoke-j5: ok');
  });
});
