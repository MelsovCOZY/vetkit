import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, test } from 'vitest';
import { ensureCliBuilt } from './test-support/build-cli.js';

const require = createRequire(import.meta.url);

function readVersion(): string {
  const pkgJson = require('../package.json');
  return pkgJson.version;
}

const binPath = fileURLToPath(new URL('../dist/bin.js', import.meta.url));

// `bun run test` runs before `bun run build` in CI (and on a fresh checkout dist/
// doesn't exist at all), so the bin this suite spawns may be missing or stale.
// ensureCliBuilt() builds packages/cli here, before spawning it, sharing a single
// build with types-public.test.ts's beforeAll via a lock so the two test files
// (which vitest runs in parallel workers) never race two tsdown builds against
// the same dist/ directory.
beforeAll(async () => {
  await ensureCliBuilt();
}, 180_000);

function runBin(
  args: string[],
  stdio: 'pipe' | ['ignore', 'pipe', 'pipe'] = 'pipe',
): { stdout: string; stderr: string; status: number | null } {
  return spawnSync(process.execPath, [binPath, ...args], { encoding: 'utf8', stdio });
}

describe('vet bin', () => {
  test('--version prints the cli package version and exits 0', () => {
    const result = runBin(['--version']);
    expect(result.stdout.trim()).toBe(readVersion());
    expect(result.status).toBe(0);
  });

  test('--help lists the doctor command and exits 0', () => {
    const result = runBin(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^\s+doctor\b/m);
  });

  test('--help lists the label command', () => {
    const result = runBin(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^\s+label\b/m);
  });

  test('--help lists the estimate command', () => {
    const result = runBin(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^\s+estimate\b/m);
  });

  test('--help lists the init command', () => {
    const result = runBin(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^\s+init\b/m);
  });

  test('--help lists the run command', () => {
    const result = runBin(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^\s+run\b/m);
  });

  test('run --help lists the --sink option', () => {
    const result = runBin(['run', '--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/--sink \[names\]/);
  });

  test('label --tty with a closed stdin exits 2 with NOT_INTERACTIVE on stderr', () => {
    const result = runBin(['label', '--tty'], ['ignore', 'pipe', 'pipe']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('NOT_INTERACTIVE');
  });

  test('doctor --help exits 0', () => {
    const result = runBin(['doctor', '--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('doctor');
  });

  test('no args prints help and exits 0', () => {
    const result = runBin([]);
    expect(result.status).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
  });

  test('an unknown command exits 2 with a one-line error on stderr', () => {
    const result = runBin(['frobnicate']);
    expect(result.status).toBe(2);
    expect(result.stderr.trim().split('\n')).toHaveLength(1);
  });

  test('bin.ts has no top-level await', () => {
    const binSourcePath = fileURLToPath(new URL('./bin.ts', import.meta.url));
    const source = readFileSync(binSourcePath, 'utf8');
    expect(source).not.toMatch(/^\s*await\s/m);
  });
});

describe('vet bin: validate and check (q4q.6)', () => {
  test('--help lists the validate and check commands', () => {
    const result = runBin(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^\s+validate\b/m);
    expect(result.stdout).toMatch(/^\s+check\b/m);
  });

  test('run --help lists the --ci option', () => {
    const result = runBin(['run', '--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/--ci\b/);
  });
});

describe('vet bin: check --outbox and lock refresh (p4a.2)', () => {
  test('--help lists the lock command; check --help lists --outbox; lock --help lists refresh', () => {
    const top = runBin(['--help']);
    expect(top.status).toBe(0);
    expect(top.stdout).toMatch(/^\s+lock\b/m);
    const check = runBin(['check', '--help']);
    expect(check.status).toBe(0);
    expect(check.stdout).toMatch(/--outbox\b/);
    const lock = runBin(['lock', '--help']);
    expect(lock.status).toBe(0);
    expect(lock.stdout).toMatch(/^\s+refresh\b/m);
  });
});

describe('vet bin: rerun --disputed (mol-p4a.3)', () => {
  test('--help lists the rerun command; rerun --help lists --disputed', () => {
    const top = runBin(['--help']);
    expect(top.status).toBe(0);
    expect(top.stdout).toMatch(/^\s+rerun\b/m);
    const rerun = runBin(['rerun', '--help']);
    expect(rerun.status).toBe(0);
    expect(rerun.stdout).toMatch(/--disputed\b/);
  });
});

describe('vet bin: criteria (mol-e3g)', () => {
  test('--help lists the criteria command', () => {
    const result = runBin(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^\s+criteria\s/m);
  });
});

describe('vet bin: init --source and lint (mol-76a.7)', () => {
  test('--help lists the lint command', () => {
    const result = runBin(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^\s+lint\b/m);
  });

  test('init --help lists --source and --out', () => {
    const result = runBin(['init', '--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/--source <spec>/);
    expect(result.stdout).toMatch(/--out <dir>/);
  });
});
