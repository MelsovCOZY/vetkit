import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES_DIR = join(ROOT, 'packages');
const TARBALL_DIR = join(ROOT, 'dist-tarballs');
const LOCK_PATH = join(ROOT, 'bun.lock');

// Matches the release-blocker checks in docs/contracts/j0.md: a packed tarball must
// contain no unresolved workspace/catalog protocol, no Bun-only type packages, and
// no Bun-runtime import.
const FORBIDDEN_PATTERN = /workspace:|catalog:|bun-types|from "bun"/;

export interface VersionMismatch {
  packageName: string;
  manifestVersion: string;
  lockVersion: string;
}

/**
 * Compares a package manifest's version against the version bun.lock has recorded
 * for that workspace. bun.lock is read as text (it is not strict JSON: trailing
 * commas), so this looks up the nearest "version" field following the workspace's
 * "name" field rather than fully parsing the file.
 */
export function checkVersionSync(
  pkg: { name: string; version: string },
  lockText: string,
): VersionMismatch | undefined {
  const escapedName = pkg.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const nameToVersion = new RegExp(`"name":\\s*"${escapedName}"[\\s\\S]*?"version":\\s*"([^"]+)"`);
  const match = lockText.match(nameToVersion);
  if (!match) return undefined;

  const lockVersion = match[1];
  if (lockVersion === pkg.version) return undefined;

  return {
    packageName: pkg.name,
    manifestVersion: pkg.version,
    lockVersion,
  };
}

/**
 * Recursively scans an extracted tarball directory for the forbidden strings that
 * would mean a stale lockfile or a Bun-only reference leaked into a published package.
 * Returns one "path:line: text" entry per match, empty when the tree is clean.
 */
export function findForbiddenStrings(dir: string): string[] {
  const matches: string[] = [];
  if (!existsSync(dir)) return matches;

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      matches.push(...findForbiddenStrings(fullPath));
      continue;
    }
    if (!entry.isFile()) continue;

    const text = readFileSync(fullPath, 'utf8');
    const lines = text.split('\n');
    for (const [index, line] of lines.entries()) {
      if (FORBIDDEN_PATTERN.test(line)) {
        matches.push(`${relative(dir, fullPath)}:${index + 1}: ${line.trim()}`);
      }
    }
  }

  return matches;
}

function readJson(path: string): { name: string; version: string } {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function packOne(pkgDir: string, pkg: { name: string; version: string }): boolean {
  const packResult = spawnSync('bun', ['pm', 'pack', '--quiet', '--destination', TARBALL_DIR], {
    cwd: pkgDir,
    encoding: 'utf8',
  });
  if (packResult.status !== 0) {
    console.error(`pack: bun pm pack failed for ${pkg.name}`);
    console.error(packResult.stderr);
    return false;
  }
  const tgzPath = packResult.stdout.trim();

  const publintResult = spawnSync(
    join(ROOT, 'node_modules/.bin/publint'),
    ['run', tgzPath, '--strict', '--pack', 'false'],
    { stdio: 'inherit' },
  );
  if (publintResult.status !== 0) {
    console.error(`pack: publint --strict failed for ${pkg.name}`);
    return false;
  }

  // --format table: attw's default "auto" format can print JSON in a non-TTY, and a
  // FalseESM/NoResolution failure must be human-diagnosable, not just a bare exit code.
  const attwResult = spawnSync(
    join(ROOT, 'node_modules/.bin/attw'),
    [tgzPath, '--profile', 'esm-only', '--format', 'table'],
    { stdio: 'inherit' },
  );
  if (attwResult.status !== 0) {
    console.error(`pack: attw --profile esm-only failed for ${pkg.name}`);
    return false;
  }

  const extractDir = mkdtempSync(join(tmpdir(), 'vetkit-pack-extract-'));
  try {
    const tarResult = spawnSync('tar', ['-xzf', tgzPath, '-C', extractDir]);
    if (tarResult.status !== 0) {
      console.error(`pack: failed to extract ${tgzPath}`);
      return false;
    }
    const extractedPkgDir = join(extractDir, 'package');

    const vpeResult = spawnSync(
      join(ROOT, 'node_modules/.bin/validate-package-exports'),
      [join(extractedPkgDir, 'package.json')],
      { stdio: 'inherit' },
    );
    if (vpeResult.status !== 0) {
      console.error(`pack: validate-package-exports failed for ${pkg.name}`);
      return false;
    }

    const forbidden = findForbiddenStrings(extractedPkgDir);
    if (forbidden.length > 0) {
      console.error(`pack: forbidden strings found in ${pkg.name}:`);
      for (const line of forbidden) console.error(`  ${line}`);
      return false;
    }
  } finally {
    rmSync(extractDir, { recursive: true, force: true });
  }

  return true;
}

async function main(): Promise<number> {
  const lockText = readFileSync(LOCK_PATH, 'utf8');
  const packageNames = readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .toSorted();

  let attempted = 0;
  let passed = 0;

  for (const name of packageNames) {
    const pkgDir = join(PACKAGES_DIR, name);
    if (!statSync(join(pkgDir, 'src', 'index.ts'), { throwIfNoEntry: false })) {
      console.warn(`WARNING: skipping ${name} (no src/index.ts yet)`);
      continue;
    }

    const pkg = readJson(join(pkgDir, 'package.json'));
    attempted++;

    const mismatch = checkVersionSync(pkg, lockText);
    if (mismatch) {
      console.error(
        `pack: version mismatch in ${mismatch.packageName}: package.json=${mismatch.manifestVersion} bun.lock=${mismatch.lockVersion}`,
      );
      continue;
    }

    if (packOne(pkgDir, pkg)) passed++;
  }

  if (passed === attempted && attempted > 0) {
    console.log(`pack: ${passed}/${attempted} tarballs ok`);
    return 0;
  }

  console.error(`pack: ${passed}/${attempted} tarballs ok`);
  return 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const code = await main();
  process.exit(code);
}
