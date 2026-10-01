import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Release check for the packed tarballs: the properties that only exist on the artifacts a
// consumer installs (LICENSE and README present, no sourcemaps, exact license and repository,
// README targets absolute, no lifecycle scripts in the install closure, no native binaries).
// Never reads env keys and installs with --ignore-scripts.

const EXPECTED_LICENSE = 'Apache-2.0';
const EXPECTED_REPOSITORY_URL = 'git+https://github.com/MelsovCOZY/vetkit.git';
const LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare'] as const;
const NPM_QUERY =
  ':attr(scripts,[preinstall]),:attr(scripts,[install]),:attr(scripts,[postinstall])';

interface PackedManifest {
  name?: unknown;
  license?: unknown;
  repository?: unknown;
  scripts?: unknown;
}

function tar(args: string[]): { ok: boolean; stdout: string } {
  const result = spawnSync('tar', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { ok: result.status === 0, stdout: result.stdout };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const FENCED_CODE = /^```[^\n]*\n[\s\S]*?^```[ \t]*$/gm;
const INLINE_CODE = /`[^`\n]*`/g;
// A markdown link or image target, or an HTML src/href attribute.
const LINK_TARGET = /(?:\]\(|\b(?:src|href)=")([^)\s"]+)/g;
const ABSOLUTE_TARGET = /^(?:[a-z][a-z0-9+.-]*:|#)/i;

/**
 * Image and link targets of a README that are neither absolute URLs nor in-page anchors. npm
 * renders a package README on its own and does not rewrite relative targets to the repository,
 * so each one is a broken image or link on the package page.
 */
export function relativeReadmeTargets(markdown: string): string[] {
  const prose = markdown.replaceAll(FENCED_CODE, '').replaceAll(INLINE_CODE, '');
  return [...prose.matchAll(LINK_TARGET)]
    .map((match) => match[1] ?? '')
    .filter((target) => target !== '' && !ABSOLUTE_TARGET.test(target));
}

/** Reasons a single tarball fails the release check; empty when it is clean. */
export function inspectTarball(tgzPath: string): string[] {
  const listing = tar(['-tzf', tgzPath]);
  if (!listing.ok) return ['cannot list tarball contents'];
  const entries = listing.stdout.split('\n').filter((line) => line !== '');

  const findings: string[] = [];
  for (const required of ['package/LICENSE', 'package/README.md']) {
    if (!entries.includes(required)) findings.push(`missing ${required}`);
  }
  for (const entry of entries.filter((e) => e.endsWith('.map'))) {
    findings.push(`contains sourcemap ${entry}`);
  }
  if (entries.includes('package/README.md')) {
    const readme = tar(['-xzOf', tgzPath, 'package/README.md']);
    if (!readme.ok) findings.push('cannot read package/README.md');
    for (const target of readme.ok ? relativeReadmeTargets(readme.stdout) : []) {
      findings.push(`README.md has the relative target ${target}; npm needs an absolute URL`);
    }
  }

  const manifestText = tar(['-xzOf', tgzPath, 'package/package.json']);
  if (!manifestText.ok) return [...findings, 'cannot read package/package.json'];
  const manifest: PackedManifest = JSON.parse(manifestText.stdout);

  if (manifest.license !== EXPECTED_LICENSE) {
    findings.push(`license is ${JSON.stringify(manifest.license)}, expected "${EXPECTED_LICENSE}"`);
  }
  const url = isRecord(manifest.repository) ? manifest.repository['url'] : undefined;
  if (url !== EXPECTED_REPOSITORY_URL) {
    findings.push(
      `repository.url is ${JSON.stringify(url)}, expected "${EXPECTED_REPOSITORY_URL}"`,
    );
  }
  if (isRecord(manifest.scripts)) {
    for (const script of LIFECYCLE_SCRIPTS) {
      if (script in manifest.scripts) findings.push(`packed package.json has scripts.${script}`);
    }
  }
  return findings;
}

/** Names of the packages in `npm query` JSON output. */
export function parseNpmQuery(json: string): string[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((item: unknown) =>
    isRecord(item) && typeof item['name'] === 'string' ? [item['name']] : [],
  );
}

/** Every `.node` file under a directory, recursively. */
export function findNodeBinaries(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith('.node'))
    .map((e) => join(e.parentPath, e.name));
}

function packageNameOf(tgzPath: string): string | undefined {
  const text = tar(['-xzOf', tgzPath, 'package/package.json']);
  if (!text.ok) return undefined;
  const manifest: PackedManifest = JSON.parse(text.stdout);
  return typeof manifest.name === 'string' ? manifest.name : undefined;
}

function tail(text: string | null | undefined): string {
  return (text ?? '').trim().split('\n').slice(-5).join(' | ');
}

/** Installs every tarball into a scratch npm project (the action/run.sh recipe) and scans it. */
function checkInstalledTree(tgzPaths: string[]): { findings: string[]; installed: number } {
  const scratch = mkdtempSync(join(tmpdir(), 'vetkit-release-check-'));
  try {
    const deps: Record<string, string> = {};
    for (const tgz of tgzPaths) {
      const name = packageNameOf(tgz);
      if (name) deps[name] = `file:${tgz}`;
    }
    writeFileSync(
      join(scratch, 'package.json'),
      JSON.stringify({
        name: 'vetkit-release-check',
        private: true,
        dependencies: deps,
        overrides: deps,
      }),
    );
    const flags = ['--ignore-scripts', '--no-audit', '--no-fund'];
    const install = spawnSync('npm', ['install', ...flags], { cwd: scratch, encoding: 'utf8' });
    if (install.error) return { findings: ['release-check: npm: cannot run npm'], installed: 0 };
    if (install.status !== 0) {
      return {
        findings: [`release-check: install failed: ${tail(install.stderr)}`],
        installed: 0,
      };
    }

    const findings: string[] = [];
    const query = spawnSync('npm', ['query', NPM_QUERY], { cwd: scratch, encoding: 'utf8' });
    if (query.status !== 0) {
      findings.push(`release-check: npm query failed: ${tail(query.stderr)}`);
    } else {
      for (const name of parseNpmQuery(query.stdout)) {
        findings.push(`release-check: ${name}: has an install lifecycle script`);
      }
    }
    const modules = join(scratch, 'node_modules');
    for (const file of existsSync(modules) ? findNodeBinaries(modules) : []) {
      findings.push(`release-check: ${file.slice(modules.length + 1)}: native .node binary`);
    }

    const all = spawnSync('npm', ['query', ':not(:root)'], { cwd: scratch, encoding: 'utf8' });
    const installed = all.status === 0 ? parseNpmQuery(all.stdout).length : 0;
    return { findings, installed };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function main(): number {
  const dirArg = process.argv[2];
  if (!dirArg) {
    console.error('release-check: usage: bun scripts/release-check.ts <tarball-dir>');
    return 1;
  }
  const dir = resolve(dirArg);
  const tgzNames = existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.tgz')) : [];
  if (tgzNames.length === 0) {
    console.error(`release-check: no tarballs in ${dirArg}`);
    return 1;
  }

  const findings: string[] = [];
  for (const name of tgzNames) {
    for (const reason of inspectTarball(join(dir, name))) {
      findings.push(`release-check: ${name}: ${reason}`);
    }
  }

  const version = spawnSync('npm', ['--version'], { encoding: 'utf8' });
  if (version.error || version.status !== 0) {
    console.error('release-check: npm: not found or not runnable');
    return 1;
  }
  const tree = checkInstalledTree(tgzNames.map((n) => join(dir, n)));
  findings.push(...tree.findings);

  if (findings.length > 0) {
    for (const line of findings) console.error(line);
    return 1;
  }
  console.log(
    `release-check: ok (${tgzNames.length} tarballs, ${tree.installed} installed packages)`,
  );
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
