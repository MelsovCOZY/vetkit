// Stages the documentation site as a Jekyll source tree, and checks that every Pages URL the repo
// writes into schemas, lint output and error messages resolves.
//
//   bun scripts/build-site.ts <outDir>     stage the tree (needs `bun run build` first)
//   bun scripts/build-site.ts --check-live request every Pages URL; exit 1 on any non-200
//
// Staging copies and rewrites; it does not render. Jekyll (actions/jekyll-build-pages) renders.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LINT_RULES, MIGRATE_DOCS, SCHEMA_CHANGELOG, SCHEMA_VERSIONS } from '@vetkit/core';

const PAGES_HOST = 'https://melsovcozy.github.io';
const PAGES_BASE = `${PAGES_HOST}/vetkit`;
const GITHUB = 'https://github.com/MelsovCOZY/vetkit';
const RAW = 'https://raw.githubusercontent.com/MelsovCOZY/vetkit/master';
const OTLP_SCHEMA = 'packages/source-otlp/src/reader/otlp.schema.json';
const SKIPPED_MESSAGE =
  'link-check: skipped (repository is private; the Pages host resolves only after the repo is public)';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const gitFiles = (root: string, ...patterns: string[]): string[] =>
  execFileSync('git', ['ls-files', '-z', ...patterns], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter((path) => path !== '');

/** Public docs pages: the top-level docs and the guides. Contracts and listings stay internal. */
const isDocsPage = (path: string): boolean => /^docs\/(guides\/)?[^/]+\.md$/.test(path);

/**
 * Maps a link found in the repo file `fromPath` to the link that works on the site. Pages of the
 * site keep their relative form with an html extension; every other repo path becomes a GitHub or
 * raw.githubusercontent.com URL.
 */
export function rewriteLink(href: string, fromPath: string): string {
  if (/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(href)) return href;
  const cut = href.search(/[#?]/);
  const pathPart = cut === -1 ? href : href.slice(0, cut);
  const suffix = cut === -1 ? '' : href.slice(cut);
  if (pathPart === '') return href;
  const fromDir = posix.dirname(fromPath);
  const target = posix.normalize(posix.join(fromDir, pathPart)).replace(/\/$/, '');
  if (target.startsWith('..')) return href;
  if (isDocsPage(target) || target === 'README.md') {
    const page = target === 'README.md' ? 'index.html' : target.replace(/\.md$/, '.html');
    return `${posix.relative(fromDir, page)}${suffix}`;
  }
  if (target.startsWith('assets/')) return `${RAW}/${target}${suffix}`;
  const kind = posix.basename(target).includes('.') ? 'blob' : 'tree';
  return `${GITHUB}/${kind}/master/${target}${suffix}`;
}

/** Jekyll runs Liquid over Markdown; a page that shows `{{` or `{%` literally must be guarded. */
export function wrapLiquid(page: string): string {
  const front = /^---\n[\s\S]*?\n---\n/.exec(page)?.[0] ?? '';
  const body = page.slice(front.length);
  if (!/\{\{|\{%/.test(body)) return page;
  return `${front}{% raw %}\n${body}${body.endsWith('\n') ? '' : '\n'}{% endraw %}\n`;
}

function rewriteMarkdownLinks(text: string, fromPath: string): string {
  let fenced = false;
  return text
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        fenced = !fenced;
        return line;
      }
      if (fenced) return line;
      return line
        .replace(
          /\]\(([^)\s]+)((?:\s+"[^"]*")?)\)/g,
          (_m, href: string, title: string) => `](${rewriteLink(href, fromPath)}${title})`,
        )
        .replace(
          /\b(src|href)="([^"]+)"/g,
          (_m, attr: string, href: string) => `${attr}="${rewriteLink(href, fromPath)}"`,
        );
    })
    .join('\n');
}

const frontMatter = (title: string): string => `---\ntitle: ${JSON.stringify(title)}\n---\n`;

function pageTitle(text: string, fallback: string): string {
  const prose = text.replace(/^(```|~~~)[\s\S]*?^\1/gm, '');
  return /^# (.+)$/m.exec(prose)?.[1]?.trim() ?? fallback;
}

function lintPage(): string {
  const sections = LINT_RULES.map((rule) => {
    const anchor = rule.id.toLowerCase().replaceAll('_', '-');
    return `## ${rule.id} {#${anchor}}\n\nSeverity: ${rule.severity}\n\n${rule.why}\n`;
  });
  const intro =
    'Every rule `vet lint` applies to criteria.yaml, with its severity and the reason for it.\n';
  return `${frontMatter('Lint rules')}# Lint rules\n\n${intro}\n${sections.join('\n')}`;
}

function migratePage(): string {
  const versions = Object.entries(SCHEMA_VERSIONS).map(
    ([format, version]) => `- ${format}: ${String(version)}`,
  );
  const changes = SCHEMA_CHANGELOG.map(
    (change) => `- ${change.format} ${String(change.version)}: ${change.summary}`,
  );
  return [
    frontMatter('Schema versions and vet migrate'),
    '# Schema versions and vet migrate\n',
    'Each versioned file format carries a version. A vetkit release reads the versions listed here and older ones.\n',
    '## Current versions\n',
    `${versions.join('\n')}\n`,
    '## Changes\n',
    `${changes.join('\n')}\n`,
    '## Migrating\n',
    'Run `vet migrate` to bring criteria.yaml and criteria.lock.json up to these versions. It keeps comments and never touches run records under .vet/runs.\n',
    'Run `vet migrate --check` to report what would change without writing anything. It exits 1 when a file needs migrating, so it can gate a CI step.\n',
  ].join('\n');
}

interface SchemaFile {
  readonly file: string;
  readonly text: string;
  readonly id: string;
}

function schemaFiles(root: string): SchemaFile[] {
  const files = [
    ...gitFiles(root, 'packages/spec/schemas').filter((path) => path.endsWith('.schema.json')),
    OTLP_SCHEMA,
  ];
  return files.map((file) => {
    const text = readFileSync(join(root, file), 'utf8');
    const schema: { $id?: string } = JSON.parse(text);
    const id = schema.$id ?? '';
    if (!id.startsWith(`${PAGES_BASE}/`))
      throw new Error(`${file}: $id ${id} is not on ${PAGES_BASE}`);
    return { file, text, id };
  });
}

/** Every file of the site, keyed by its path under the site root. */
function planSite(root: string): Map<string, string> {
  const site = new Map<string, string>();
  site.set('_config.yml', `title: vetkit\nbaseurl: /vetkit\nurl: ${PAGES_HOST}\n`);
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  site.set(
    'index.md',
    wrapLiquid(`${frontMatter('vetkit')}${rewriteMarkdownLinks(readme, 'README.md')}`),
  );
  for (const path of gitFiles(root, 'docs').filter(isDocsPage)) {
    const text = readFileSync(join(root, path), 'utf8');
    const page = `${frontMatter(pageTitle(text, posix.basename(path, '.md')))}${rewriteMarkdownLinks(text, path)}`;
    site.set(path, wrapLiquid(page));
  }
  site.set('docs/lint.md', wrapLiquid(lintPage()));
  site.set('docs/migrate.md', wrapLiquid(migratePage()));
  for (const schema of schemaFiles(root))
    site.set(schema.id.slice(PAGES_BASE.length + 1), schema.text);
  if (existsSync(join(root, 'llms.txt')))
    site.set('llms.txt', readFileSync(join(root, 'llms.txt'), 'utf8'));
  return site;
}

export function stageSite(root: string, outDir: string): void {
  for (const [path, text] of planSite(root)) {
    const dest = join(outDir, path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, text);
  }
}

const pageUrl = (path: string): string =>
  path === 'index.md' ? `${PAGES_BASE}/` : `${PAGES_BASE}/${path.replace(/\.md$/, '.html')}`;

/** Every URL on the Pages host that the repo writes down or stages. */
export function collectPagesUrls(root: string): string[] {
  const urls = new Set<string>();
  for (const path of planSite(root).keys()) {
    if (path !== '_config.yml') urls.add(pageUrl(path));
  }
  // The source-jsonl inline ids are ajv registration keys, never served, so they are left out.
  for (const schema of schemaFiles(root)) urls.add(schema.id);
  for (const rule of LINT_RULES) urls.add(rule.docs);
  urls.add(MIGRATE_DOCS);
  for (const path of gitFiles(root, 'packages/*/package.json')) {
    if (path.split('/').length !== 3) continue;
    const manifest: { homepage?: string } = JSON.parse(readFileSync(join(root, path), 'utf8'));
    if (manifest.homepage !== undefined) urls.add(manifest.homepage);
  }
  return [...urls].toSorted((a, b) => a.localeCompare(b));
}

export function liveCheckPlan(isPrivate: boolean): { check: boolean; message: string } {
  return isPrivate
    ? { check: false, message: SKIPPED_MESSAGE }
    : { check: true, message: 'link-check: requesting every Pages URL' };
}

async function status(url: string): Promise<number> {
  const head = await fetch(url, { method: 'HEAD' });
  if (head.status === 200) return 200;
  return (await fetch(url)).status;
}

async function checkLive(root: string): Promise<number> {
  let failed = 0;
  for (const url of collectPagesUrls(root)) {
    const code = await status(url).catch(() => 0);
    if (code !== 200) failed++;
    console.log(`${code === 0 ? 'error' : String(code)} ${url}`);
  }
  return failed === 0 ? 0 : 1;
}

async function main(argv: readonly string[]): Promise<number> {
  const arg = argv[0];
  if (arg === '--check-live') return checkLive(ROOT);
  if (arg === undefined || arg.startsWith('-')) {
    console.error('usage: bun scripts/build-site.ts <outDir> | --check-live');
    return 2;
  }
  stageSite(ROOT, arg);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)));
}
