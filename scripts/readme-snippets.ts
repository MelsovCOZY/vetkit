// Executes every README snippet from packed tarballs: `bun scripts/readme-snippets.ts <tarball-dir>`.
// Scans README.md, packages/*/README.md and examples/*/README.md; one scratch project per README with
// every tarball installed through `overrides` (as scripts/consumer-matrix.sh does) plus the two pinned
// external tools. The tarball set is installed once into a template project and hard-linked into
// each scratch project, so only a README with dependencies of its own runs npm install again.
// Live integration check (real installs): it is not part of the unit suite.
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Registry packages a snippet scratch project may use besides the tarballs. promptfoo is pinned
 * here; vitest is installed at the version this repo is built with (see repoVitestVersion).
 */
const EXTERNAL_NAMES = ['vitest', 'promptfoo'] as const;
const PROMPTFOO_VERSION = '0.123.1';

const KEY_VARS = [
  'AI_GATEWAY_API_KEY',
  'OPENROUTER_API_KEY',
  'TYPESAFE_API_KEY',
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID',
] as const;

const SNIPPET_LANGS = new Set(['sh', 'bash', 'ts', 'js', 'yaml', 'json']);

export interface Snippet {
  /** 1-based line of the opening fence. */
  readonly line: number;
  readonly lang: string;
  readonly code: string;
  /** run: execute; write: write to `file`; skip: counted, not run; error: fails the run. */
  readonly action: 'run' | 'write' | 'skip' | 'error';
  readonly file?: string;
  readonly reason?: string;
  readonly error?: string;
  readonly env: Readonly<Record<string, string>>;
}

interface Directive {
  file?: string;
  skip?: { reason?: string };
  env: Record<string, string>;
  error?: string;
}

const DIRECTIVE = /^<!--\s*snippet:\s*(.*?)\s*-->\s*$/;

function applyDirective(directive: Directive, body: string): void {
  if (body.startsWith('file=')) {
    directive.file = body.slice('file='.length).trim();
  } else if (body === 'skip' || body.startsWith('skip ')) {
    const reason = /^skip\s+reason="([^"]+)"$/.exec(body)?.[1];
    directive.skip = reason === undefined ? {} : { reason };
  } else if (body.startsWith('env ')) {
    for (const pair of body.slice('env '.length).trim().split(/\s+/)) {
      const at = pair.indexOf('=');
      if (at <= 0) directive.error = `env directive needs KEY=value, got "${pair}"`;
      else directive.env[pair.slice(0, at)] = pair.slice(at + 1);
    }
  } else {
    directive.error = `unknown snippet directive "${body}"`;
  }
}

function classify(lang: string, directive: Directive): Pick<Snippet, 'action'> & Partial<Snippet> {
  if (directive.error !== undefined) return { action: 'error', error: directive.error };
  if (directive.skip !== undefined) {
    if (directive.skip.reason === undefined) {
      return { action: 'error', error: 'skip directive needs reason="..."' };
    }
    return { action: 'skip', reason: directive.skip.reason };
  }
  if (directive.file !== undefined) {
    const file = directive.file;
    if (file === '' || file.startsWith('/') || file.split(/[\\/]/).includes('..')) {
      return { action: 'error', error: `file= path must stay inside the scratch project: ${file}` };
    }
    return { action: 'write', file };
  }
  if (lang === 'yaml' || lang === 'json') {
    return { action: 'error', error: 'yaml/json block needs snippet: file=' };
  }
  return { action: 'run' };
}

/**
 * Finds the snippet fences of a README. A directive is a `<!-- snippet: ... -->` line above the
 * fence (blank lines between them are allowed: the formatter inserts one). Only top-level fences
 * count; fences inside an HTML comment and fences with another info string are ignored.
 */
export function extractSnippets(markdown: string): Snippet[] {
  const lines = markdown.replaceAll('\r\n', '\n').split('\n');
  const snippets: Snippet[] = [];
  let directive: Directive = { env: {} };
  let inComment = false;
  let index = 0;
  while (index < lines.length) {
    const text = lines[index] ?? '';
    index += 1;
    if (inComment) {
      if (text.includes('-->')) inComment = false;
      continue;
    }
    const directiveBody = DIRECTIVE.exec(text)?.[1];
    if (directiveBody !== undefined) {
      applyDirective(directive, directiveBody);
      continue;
    }
    if (text.startsWith('<!--')) {
      inComment = !text.includes('-->');
      continue;
    }
    const fence = /^```(\S*)\s*$/.exec(text);
    if (fence === null) {
      if (text.trim() !== '') directive = { env: {} };
      continue;
    }
    const lang = fence[1] ?? '';
    const openLine = index;
    const body: string[] = [];
    while (index < lines.length && !/^```\s*$/.test(lines[index] ?? '')) {
      body.push(lines[index] ?? '');
      index += 1;
    }
    index += 1;
    const used = directive;
    directive = { env: {} };
    if (!SNIPPET_LANGS.has(lang)) continue;
    snippets.push({
      line: openLine,
      lang,
      code: body.join('\n'),
      env: used.env,
      ...classify(lang, used),
    });
  }
  return snippets;
}

const INSTALL_LINE =
  /^\s*(?:npm\s+(?:i|install|add)|pnpm\s+(?:add|i|install)|bun\s+(?:add|i)|yarn\s+add)\s+(.+)$/;

function packageName(spec: string): string {
  return /^(@[^/]+\/[^@]+|[^@]+)/.exec(spec)?.[1] ?? spec;
}

/**
 * Turns an install line into a no-op when every package is a tarball package or a pinned
 * external (already installed in the scratch project); throws naming any other package.
 * Lines that are not installs come back unchanged.
 */
export function rewriteInstall(line: string, tarballNames: readonly string[]): string {
  const args = INSTALL_LINE.exec(line)?.[1];
  if (args === undefined) return line;
  const names = args
    .trim()
    .split(/\s+/)
    .filter((token) => !token.startsWith('-'))
    .map(packageName);
  if (names.length === 0) return line;
  const allowed = new Set<string>([...tarballNames, ...EXTERNAL_NAMES]);
  const unknown = names.filter((name) => !allowed.has(name));
  if (unknown.length > 0) {
    throw new Error(`package not installed by the snippet runner: ${unknown.join(', ')}`);
  }
  return 'true';
}

/** The vitest version this repo is built and tested with: the root package.json is the one source. */
export function repoVitestVersion(root: string = ROOT): string {
  const manifest: { devDependencies?: Record<string, string> } = JSON.parse(
    readFileSync(join(root, 'package.json'), 'utf8'),
  );
  const version = manifest.devDependencies?.['vitest'];
  if (version === undefined) throw new Error(`no devDependencies.vitest in ${root}/package.json`);
  return version;
}

interface ProjectManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}

interface ScratchManifest {
  name: string;
  private: true;
  type: 'module';
  dependencies: Record<string, string>;
  devDependencies?: Record<string, string>;
  overrides: Record<string, string>;
}

/**
 * The package.json of a snippet scratch project: `base` (an example's own manifest, or `{}`)
 * with every tarball installed from its file and forced through `overrides`, plus the external
 * tools. vitest is installed at `vitestVersion` and overridden to the same version, and a vitest
 * spec `base` declares is rewritten to it: npm rejects an override that disagrees with a direct
 * spec, and npm 10 crashes in its resolver on an exact vitest spec older than the newest release
 * unless that version is also overridden.
 */
export function scratchManifest(
  base: ProjectManifest,
  tarballs: Readonly<Record<string, string>>,
  vitestVersion: string,
): ScratchManifest {
  const deps = Object.fromEntries(Object.entries(tarballs).map(([n, p]) => [n, `file:${p}`]));
  const own = Object.fromEntries(
    Object.entries(base.dependencies ?? {}).filter(([n]) => deps[n] === undefined),
  );
  return {
    ...base,
    name: 'readme-snippets',
    private: true,
    type: 'module',
    dependencies: { ...own, ...deps, vitest: vitestVersion, promptfoo: PROMPTFOO_VERSION },
    ...(base.devDependencies?.['vitest'] !== undefined && {
      devDependencies: { ...base.devDependencies, vitest: vitestVersion },
    }),
    overrides: { ...deps, vitest: vitestVersion },
  };
}

function sortedEntries(record: Readonly<Record<string, string>> = {}): [string, string][] {
  return Object.entries(record).toSorted(([a], [b]) => a.localeCompare(b));
}

/** True when npm would build the same node_modules for both manifests (name, scripts etc. aside). */
export function sameInstall(a: ScratchManifest, b: ScratchManifest): boolean {
  const key = (manifest: ScratchManifest): string =>
    JSON.stringify([
      sortedEntries(manifest.dependencies),
      sortedEntries(manifest.devDependencies),
      sortedEntries(manifest.overrides),
    ]);
  return key(a) === key(b);
}

/**
 * Fills `dir/node_modules` from the template's. Hard links share the installed files at no cost on
 * one filesystem; a recursive copy is the fallback when linking fails (another filesystem, no cp).
 * The hidden lockfile is always a real copy: npm rewrites it in place, which through a hard link
 * would change the template's.
 */
export function populateNodeModules(templateDir: string, dir: string): 'linked' | 'copied' {
  const from = join(templateDir, 'node_modules');
  const to = join(dir, 'node_modules');
  const link = spawnSync('cp', ['-al', from, to], { stdio: 'ignore' });
  const how = link.status === 0 ? 'linked' : 'copied';
  if (how === 'copied') {
    rmSync(to, { recursive: true, force: true });
    cpSync(from, to, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
  }
  const hidden = join(from, '.package-lock.json');
  if (existsSync(hidden)) {
    rmSync(join(to, '.package-lock.json'), { force: true });
    copyFileSync(hidden, join(to, '.package-lock.json'));
  }
  return how;
}

function tarballPackages(dir: string): Record<string, string> {
  const packages: Record<string, string> = {};
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.tgz'))) {
    const full = join(dir, file);
    const result = spawnSync('tar', ['-xzOf', full, 'package/package.json'], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`cannot read package.json from ${full}`);
    const manifest: { name: string } = JSON.parse(result.stdout);
    packages[manifest.name] = full;
  }
  return packages;
}

function readmes(): string[] {
  const found = [join(ROOT, 'README.md')];
  for (const group of ['packages', 'examples']) {
    const base = join(ROOT, group);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (entry.isDirectory()) found.push(join(base, entry.name, 'README.md'));
    }
  }
  return found.filter((path) => existsSync(path)).toSorted();
}

function scratchEnv(dir: string, extra: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const name of KEY_VARS) delete env[name];
  env['PATH'] = `${join(dir, 'node_modules', '.bin')}:${env['PATH'] ?? ''}`;
  return env;
}

function nodeFlags(lang: string): string[] {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  const strips = major > 22 || (major === 22 && minor >= 18);
  return lang === 'ts' && !strips ? ['--experimental-strip-types'] : [];
}

interface Counts {
  blocks: number;
  skipped: number;
}

interface Template {
  readonly dir: string;
  readonly tarballs: Readonly<Record<string, string>>;
  readonly manifest: ScratchManifest;
}

function npmInstall(dir: string): number | null {
  return spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: dir, stdio: 'inherit' })
    .status;
}

/** Installs the tarball set once into `dir`; every scratch project starts from this tree. */
function installTemplate(dir: string, tarballs: Record<string, string>): Template | undefined {
  const manifest = scratchManifest({}, tarballs, repoVitestVersion());
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, null, 2));
  const status = npmInstall(dir);
  if (status !== 0) {
    console.error(`readme-snippets: FAIL template install (npm install exit ${String(status)})`);
    return undefined;
  }
  return { dir, tarballs, manifest };
}

function runReadme(path: string, template: Template, counts: Counts): boolean {
  const name = relative(ROOT, path);
  const snippets = extractSnippets(readFileSync(path, 'utf8'));
  const failures = snippets.filter((snippet) => snippet.action === 'error');
  for (const failure of failures) {
    console.error(`readme-snippets: ${name}:${failure.line}: ${failure.error ?? ''}`);
  }
  if (failures.length > 0) return false;
  for (const snippet of snippets.filter((s) => s.action === 'skip')) {
    counts.skipped += 1;
    console.log(`readme-snippets: skip ${name}:${snippet.line} (${snippet.reason ?? ''})`);
  }
  if (snippets.every((snippet) => snippet.action === 'skip')) return true;

  const dir = mkdtempSync(join(tmpdir(), 'vetkit-readme-'));
  try {
    // An example README runs inside a copy of its own project (config, evals, traces).
    const exampleDir = dirname(path);
    const isExample = dirname(exampleDir) === join(ROOT, 'examples');
    if (isExample)
      cpSync(exampleDir, dir, {
        recursive: true,
        filter: (from) => !from.includes('node_modules'),
      });
    const base: ProjectManifest = isExample
      ? JSON.parse(readFileSync(join(exampleDir, 'package.json'), 'utf8'))
      : {};
    const manifest = scratchManifest(base, template.tarballs, repoVitestVersion());
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, null, 2));
    populateNodeModules(template.dir, dir);
    // Only a README whose project declares dependencies beyond the template (an example's own)
    // installs again; npm then finds every template package already in place.
    if (!sameInstall(manifest, template.manifest)) {
      const status = npmInstall(dir);
      if (status !== 0) {
        console.error(`readme-snippets: FAIL ${name} (npm install exit ${String(status)})`);
        return false;
      }
    }
    for (const snippet of snippets) {
      if (snippet.action === 'skip') continue;
      counts.blocks += 1;
      if (snippet.action === 'write') {
        const target = join(dir, snippet.file ?? '');
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, `${snippet.code}\n`);
        continue;
      }
      const env = scratchEnv(dir, snippet.env);
      let result;
      if (snippet.lang === 'sh' || snippet.lang === 'bash') {
        const script = snippet.code
          .split('\n')
          .map((line) => rewriteInstall(line, Object.keys(template.tarballs)))
          .join('\n');
        result = spawnSync('bash', ['-euo', 'pipefail', '-c', script], {
          cwd: dir,
          env,
          stdio: 'inherit',
        });
      } else {
        const file = `snippet-${String(counts.blocks)}.${snippet.lang}`;
        writeFileSync(join(dir, file), `${snippet.code}\n`);
        result = spawnSync('node', [...nodeFlags(snippet.lang), file], {
          cwd: dir,
          env,
          stdio: 'inherit',
        });
      }
      if (result.status !== 0) {
        console.error(
          `readme-snippets: FAIL ${name}:${snippet.line} (exit ${String(result.status)})`,
        );
        return false;
      }
    }
    return true;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main(argv: readonly string[]): number {
  const tarballDir = argv[0];
  if (tarballDir === undefined || !existsSync(tarballDir)) {
    console.error(
      `usage: bun scripts/readme-snippets.ts <tarball-dir> (not found: ${String(tarballDir)})`,
    );
    return 1;
  }
  const tarballs = tarballPackages(join(process.cwd(), tarballDir));
  const files = readmes();
  const counts: Counts = { blocks: 0, skipped: 0 };
  const templateDir = mkdtempSync(join(tmpdir(), 'vetkit-readme-template-'));
  try {
    const template = installTemplate(templateDir, tarballs);
    if (template === undefined) return 1;
    for (const path of files) {
      let ok: boolean;
      try {
        ok = runReadme(path, template, counts);
      } catch (error) {
        console.error(`readme-snippets: FAIL ${relative(ROOT, path)}: ${String(error)}`);
        ok = false;
      }
      if (!ok) return 1;
    }
    console.log(
      `readme-snippets: ok (${String(counts.blocks)} blocks in ${String(files.length)} files, ${String(counts.skipped)} skipped)`,
    );
    return 0;
  } finally {
    rmSync(templateDir, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
