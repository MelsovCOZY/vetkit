import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkVersionSync, findForbiddenStrings } from './pack.ts';

// Release-blocker checks: npm < 11.5.1 cannot do OIDC
// trusted publishing, a stale bun.lock ships the wrong version, and a packed tarball
// must not leak workspace:/catalog:/bun-only references. checkVersionSync and
// findForbiddenStrings live in scripts/pack.ts and are reused here.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES_DIR = join(ROOT, 'packages');
const LOCK_PATH = join(ROOT, 'bun.lock');

const MIN_NPM_VERSION = [11, 5, 1] as const;

export interface NpmVersionCheck {
  ok: boolean;
  message: string;
}

/** Fails below the 11.5.1 floor that npm trusted publishing (OIDC) requires. */
export function checkNpmVersion(version: string): NpmVersionCheck {
  const [major = 0, minor = 0, patch = 0] = version
    .trim()
    .split('.')
    .map((n) => Number.parseInt(n, 10));
  const [minMajor, minMinor, minPatch] = MIN_NPM_VERSION;
  const floor = MIN_NPM_VERSION.join('.');
  const ok =
    major > minMajor ||
    (major === minMajor && minor > minMinor) ||
    (major === minMajor && minor === minMinor && patch >= minPatch);

  return {
    ok,
    message: ok
      ? `npm ${version} satisfies the >=${floor} trusted-publishing requirement`
      : `npm ${version} is below the >=${floor} required for OIDC trusted publishing`,
  };
}

export interface PackageManifest {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
}

/**
 * Topologically sorts package directory names by their @vetkit/* dependency graph so
 * a dependency is always ordered before its dependent (e.g. spec before core before
 * cli), derived from the manifests rather than a hard-coded bucket list.
 */
export function topoSortPackages(manifests: Record<string, PackageManifest>): string[] {
  const dirByName = new Map<string, string>();
  for (const [dir, manifest] of Object.entries(manifests)) dirByName.set(manifest.name, dir);

  const visited = new Set<string>();
  const order: string[] = [];

  function visit(dir: string): void {
    if (visited.has(dir)) return;
    visited.add(dir);
    const manifest = manifests[dir];
    if (!manifest) return;
    for (const dep of Object.keys(manifest.dependencies ?? {})) {
      if (!dep.startsWith('@vetkit/')) continue;
      const depDir = dirByName.get(dep);
      if (depDir) visit(depDir);
    }
    order.push(dir);
  }

  for (const dir of Object.keys(manifests).toSorted()) visit(dir);
  return order;
}

/** The filename `bun pm pack` gives a package's tarball: scope stripped, `/` -> `-`. */
export function tgzFilenameFor(pkg: { name: string; version: string }): string {
  const slug = pkg.name.replace(/^@/, '').replace(/\//g, '-');
  return `${slug}-${pkg.version}.tgz`;
}

function loadManifests(): Record<string, PackageManifest> {
  const dirs = readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  const manifests: Record<string, PackageManifest> = {};
  for (const dir of dirs) {
    const manifestPath = join(PACKAGES_DIR, dir, 'package.json');
    if (!existsSync(manifestPath)) continue;
    manifests[dir] = JSON.parse(readFileSync(manifestPath, 'utf8'));
  }
  return manifests;
}

function runPrePackChecks(): number {
  const npmVersionResult = spawnSync('npm', ['--version'], { encoding: 'utf8' });
  const npmCheck = checkNpmVersion(npmVersionResult.stdout.trim());
  if (!npmCheck.ok) {
    console.error(`release-preflight: ${npmCheck.message}`);
    return 1;
  }

  const lockText = readFileSync(LOCK_PATH, 'utf8');
  let ok = true;
  for (const manifest of Object.values(loadManifests())) {
    const mismatch = checkVersionSync(manifest, lockText);
    if (mismatch) {
      console.error(
        `release-preflight: version mismatch in ${mismatch.packageName}: ` +
          `package.json=${mismatch.manifestVersion} bun.lock=${mismatch.lockVersion}`,
      );
      ok = false;
    }
  }

  if (!ok) return 1;
  console.log('release-preflight: pre-pack checks ok');
  return 0;
}

/** Extracts one tarball to a scratch directory and scans it for forbidden strings. */
export function scanTarballForForbiddenStrings(tgzPath: string): string[] {
  const extractDir = mkdtempSync(join(tmpdir(), 'vetkit-preflight-extract-'));
  try {
    const tarResult = spawnSync('tar', ['-xzf', tgzPath, '-C', extractDir]);
    if (tarResult.status !== 0) {
      return [`${tgzPath}: failed to extract for scanning`];
    }
    return findForbiddenStrings(extractDir);
  } finally {
    rmSync(extractDir, { recursive: true, force: true });
  }
}

function runPostPackCheck(tarballDir: string): number {
  if (!existsSync(tarballDir)) {
    console.error(`release-preflight: tarball directory ${tarballDir} does not exist`);
    return 1;
  }

  const tgzNames = readdirSync(tarballDir).filter((name) => name.endsWith('.tgz'));
  let ok = true;
  for (const name of tgzNames) {
    const matches = scanTarballForForbiddenStrings(join(tarballDir, name));
    if (matches.length > 0) {
      console.error(`release-preflight: forbidden strings found in ${name}:`);
      for (const line of matches) console.error(`  ${line}`);
      ok = false;
    }
  }

  if (!ok) return 1;
  console.log(`release-preflight: post-pack scan ok (${tgzNames.length} tarball(s))`);
  return 0;
}

function runPublishOrder(): number {
  const manifests = loadManifests();
  for (const dir of topoSortPackages(manifests)) {
    const manifest = manifests[dir];
    if (!manifest) continue;
    console.log([dir, manifest.name, manifest.version, tgzFilenameFor(manifest)].join('\t'));
  }
  return 0;
}

function main(): number {
  const args = process.argv.slice(2);
  if (args.includes('--publish-order')) return runPublishOrder();

  const tarballsIdx = args.indexOf('--tarballs');
  if (tarballsIdx >= 0) {
    const tarballDir = args[tarballsIdx + 1];
    if (!tarballDir) {
      console.error('release-preflight: --tarballs requires a directory argument');
      return 1;
    }
    return runPostPackCheck(tarballDir);
  }

  return runPrePackChecks();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
