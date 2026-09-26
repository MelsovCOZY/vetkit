import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts/smoke-j0.sh');

describe('scripts/smoke-j0.sh', () => {
  it('clones HEAD, checks/builds/packs it and runs the consumer matrix, printing ok', () => {
    const result = spawnSync('sh', [SCRIPT], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 20 * 60 * 1000,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('smoke-j0: ok');
  });
});
