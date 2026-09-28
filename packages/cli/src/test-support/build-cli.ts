import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// program.test.ts and types-public.test.ts both need packages/cli built before they run
// (fresh checkout / `bun run test` before `bun run build`), and vitest runs test files
// in parallel workers. Two independent `bun x tsdown` invocations racing on the same
// dist/ directory is exactly the flake this module exists to remove: one worker's
// `tsdown --publint` can read dist/ mid-write by the other. This helper makes both
// test files share a single build, guarded by an O_EXCL lock file so only one worker
// ever runs tsdown per vitest invocation; the rest wait for dist/ to stop being stale.

const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
const srcDir = fileURLToPath(new URL('..', import.meta.url));
const distDir = join(packageRoot, 'dist');
// A fixed, well-known path so unrelated processes (this package has one build target)
// contend on the same lock rather than each picking a private temp file.
const lockPath = join(tmpdir(), 'vetkit-cli-build.lock');

const LOCK_STALE_MS = 60_000;
const LOCK_POLL_MS = 50;
const WAIT_TIMEOUT_MS = 60_000;

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

function isDistStale(): boolean {
  if (!existsSync(distDir)) return true;
  return newestMtimeMs(srcDir) > newestMtimeMs(distDir);
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
  const result = spawnSync('bun', ['x', 'tsdown'], { cwd: packageRoot, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`tsdown build failed for packages/cli:\n${result.stdout}\n${result.stderr}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Builds packages/cli at most once across parallel vitest workers, sharing the build
 * via a lock-guarded file under the OS temp dir. Rebuilds only when dist/ is missing
 * or older than the newest file under src/, and resolves only once the build (by this
 * call or a concurrent one) has finished.
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
      throw new Error(`timed out waiting for packages/cli build lock at ${lockPath}`);
    }

    await sleep(LOCK_POLL_MS);
  }
}
