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
}, 60_000);

function runBin(args: string[]): { stdout: string; stderr: string; status: number | null } {
  return spawnSync(process.execPath, [binPath, ...args], { encoding: 'utf8' });
}

describe('vet bin', () => {
  test('--version prints the cli package version and exits 0', () => {
    const result = runBin(['--version']);
    expect(result.stdout.trim()).toBe(readVersion());
    expect(result.status).toBe(0);
  });

  test('--help lists no subcommands yet and exits 0', () => {
    const result = runBin(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toMatch(/Commands:/);
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
