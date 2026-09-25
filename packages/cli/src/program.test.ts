import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);

function readVersion(): string {
  const pkgJson = require('../package.json');
  return pkgJson.version;
}

const binPath = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const srcDir = fileURLToPath(new URL('.', import.meta.url));

// `bun run test` runs before `bun run build` in CI (and on a fresh checkout dist/
// doesn't exist at all), so the bin this suite spawns may be missing or stale.
// Build packages/cli here, before spawning it - only when dist/bin.js is absent
// or older than the newest file under src/.
function newestMtimeMs(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryPath = `${dir}/${entry.name}`;
    newest = Math.max(
      newest,
      entry.isDirectory() ? newestMtimeMs(entryPath) : statSync(entryPath).mtimeMs,
    );
  }
  return newest;
}

function isBinStale(): boolean {
  if (!existsSync(binPath)) return true;
  return newestMtimeMs(srcDir) > statSync(binPath).mtimeMs;
}

function ensureBinBuilt(): void {
  if (!isBinStale()) return;
  const result = spawnSync('bun', ['x', 'tsdown'], { cwd: packageRoot, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`tsdown build failed for packages/cli:\n${result.stdout}\n${result.stderr}`);
  }
}

beforeAll(() => {
  ensureBinBuilt();
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
