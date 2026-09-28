import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The CLI tests spawn packages/cli/dist/bin.js, which imports @vetkit/spec, core and
// judge-jev through their package.json exports (./dist). On a fresh checkout none of
// those dist/ directories exist, so this helper builds the whole chain in dependency
// order. vitest runs test files in parallel workers, and two tsdown runs racing on one
// dist/ directory flake (one worker's `tsdown --publint` reads dist/ mid-write), so the
// build runs under an O_EXCL lock file: one worker builds, the rest wait for dist/ to
// stop being stale.

const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));
// Dependency order: each package's dist must exist before the next one builds.
const BUILD_ORDER = ['spec', 'core', 'judge-jev', 'cli'] as const;
const packageRoots = BUILD_ORDER.map((name) => join(repoRoot, 'packages', name));
// Keyed by the repo root so separate checkouts (git worktrees) never share a lock,
// while every worker of one checkout contends on the same file.
const repoHash = createHash('sha256').update(repoRoot).digest('hex').slice(0, 16);
const lockPath = join(tmpdir(), `vetkit-build-${repoHash}.lock`);

const LOCK_STALE_MS = 180_000;
const LOCK_POLL_MS = 50;
const WAIT_TIMEOUT_MS = 180_000;

function newestMtimeMs(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryPath = join(dir, entry.name);
    newest = Math.max(
      newest,
      entry.isDirectory() ? newestMtimeMs(entryPath) : statSync(entryPath).mtimeMs,
    );
  }
  return newest;
}

function isPackageStale(packageRoot: string): boolean {
  const distDir = join(packageRoot, 'dist');
  if (!existsSync(distDir)) return true;
  return newestMtimeMs(join(packageRoot, 'src')) > newestMtimeMs(distDir);
}

function isDistStale(): boolean {
  return packageRoots.some(isPackageStale);
}

function isEexist(err: unknown): boolean {
  return err instanceof Error && 'code' in err && err.code === 'EEXIST';
}

function tryAcquireLock(): boolean {
  try {
    closeSync(openSync(lockPath, 'wx'));
    return true;
  } catch (err) {
    if (isEexist(err)) return false;
    throw err;
  }
}

function releaseLock(): void {
  rmSync(lockPath, { force: true });
}

function lockAgeMs(): number {
  try {
    return Date.now() - statSync(lockPath).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function runBuild(): void {
  for (const packageRoot of packageRoots) {
    const result = spawnSync('bun', ['x', 'tsdown'], { cwd: packageRoot, encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(
        `tsdown build failed for ${packageRoot}:\n${result.stdout}\n${result.stderr}`,
      );
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Builds spec → core → judge-jev → cli at most once across parallel vitest workers,
 * sharing the build via a lock-guarded file under the OS temp dir. Rebuilds when any
 * of those packages' dist/ is missing or older than the newest file under its src/, and
 * resolves only once the build (by this call or a concurrent one) has finished.
 */
export async function ensureCliBuilt(): Promise<void> {
  if (!isDistStale()) return;

  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  for (;;) {
    if (tryAcquireLock()) {
      try {
        if (isDistStale()) runBuild();
      } finally {
        releaseLock();
      }
      return;
    }

    if (lockAgeMs() > LOCK_STALE_MS) {
      releaseLock();
      continue;
    }

    if (!isDistStale()) return;

    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for the workspace build lock at ${lockPath}`);
    }

    await sleep(LOCK_POLL_MS);
  }
}
