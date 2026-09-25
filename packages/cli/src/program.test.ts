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

// scripts/tsconfig.test.ts (a sibling project) deletes packages/*/dist mid-run to
// exercise typecheck on an unbuilt tree; when vitest runs both projects concurrently
// that can remove this package's dist between a check above and a test actually
// spawning it. A bin missing at spawn time fails node's ESM loader with ENOENT (or,
// depending on timing, a CJS-style "Cannot find module"), never a --version/--help/
// unknown-command outcome, so it's unambiguous to detect and retry: rebuild and spawn
// again, bounded, to close that remaining TOCTOU gap.
function runBin(args: string[]): { stdout: string; stderr: string; status: number | null } {
  for (let attempt = 0; ; attempt++) {
    ensureBinBuilt();
    const result = spawnSync(process.execPath, [binPath, ...args], { encoding: 'utf8' });
    const binWasDeletedMidRace =
      result.status === 1 && /ENOENT|Cannot find module/.test(result.stderr);
    if (!binWasDeletedMidRace || attempt >= 5) return result;
  }
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
