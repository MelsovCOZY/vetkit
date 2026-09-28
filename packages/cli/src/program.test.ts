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
