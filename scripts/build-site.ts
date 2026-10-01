// Stages the documentation site as a Jekyll source tree, and checks that every Pages URL the repo
// writes into schemas, lint output and error messages resolves.
//
//   bun scripts/build-site.ts <outDir>     stage the tree (needs `bun run build` first)
//   bun scripts/build-site.ts --check-live request every Pages URL; exit 1 on any non-200
//
// Staging copies and rewrites; it does not render. Jekyll (actions/jekyll-build-pages) renders.
// GOOGLE_SITE_VERIFICATION, when set, goes into _config.yml for the Search Console meta tag.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LINT_RULES, MIGRATE_DOCS, SCHEMA_CHANGELOG, SCHEMA_VERSIONS } from '@vetkit/core';
import { stringify } from 'yaml';

const PAGES_HOST = 'https://melsovcozy.github.io';
const PAGES_BASE = `${PAGES_HOST}/vetkit`;
const GITHUB = 'https://github.com/MelsovCOZY/vetkit';
const RAW = 'https://raw.githubusercontent.com/MelsovCOZY/vetkit/master';
const OTLP_SCHEMA = 'packages/source-otlp/src/reader/otlp.schema.json';
const SKIPPED_MESSAGE =
  'link-check: skipped (repository is private; the Pages host resolves only after the repo is public)';

const TAGLINE = 'Generate, validate and run LLM evals';
/** Served from the site and named in _config.yml for the seo tag: the logo and the social image. */
const ASSETS = ['assets/logo.png', 'assets/social-preview.png'];
const DESCRIPTION_MAX = 160;
/** Pages whose source has no H1: the title and opening paragraph the site puts in front of them. */
const SUPPLIED_PAGES: Record<string, { title: string; intro: string }> = {
  'docs/guides/cli-json.md': {
    title: 'JSON output shapes of the vet CLI',
    intro:
      'The JSON document each vet command prints in JSON mode: an example and the field table for every shape.',
  },
};

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const gitFiles = (root: string, ...patterns: string[]): string[] =>
  execFileSync('git', ['ls-files', '-z', ...patterns], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter((path) => path !== '');

/**
 * Public docs pages: the top-level docs and the guides. Contracts, listings and the INDEX.md map of
 * the docs tree stay internal.
 */
const isDocsPage = (path: string): boolean =>
  /^docs\/(guides\/)?[^/]+\.md$/.test(path) && posix.basename(path) !== 'INDEX.md';

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

const frontMatter = (title: string, description: string): string =>
  `---\ntitle: ${JSON.stringify(title)}\ndescription: ${JSON.stringify(description)}\n---\n`;

const withoutFences = (text: string): string => text.replace(/^(```|~~~)[\s\S]*?^\1/gm, '');

const pageTitle = (text: string): string | undefined =>
  /^# (.+)$/m.exec(withoutFences(text))?.[1]?.trim();

/** The first prose paragraph as plain text, cut to the length a search result shows. */
function firstParagraph(text: string): string | undefined {
  const lines = withoutFences(text).split('\n');
  const start = lines.findIndex((line) => line.trim() !== '' && !/^[#<[!|>-]/.test(line.trim()));
  if (start === -1) return undefined;
  const end = lines.findIndex((line, i) => i > start && line.trim() === '');
  const plain = lines
    .slice(start, end === -1 ? undefined : end)
    .join(' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[`*]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (plain === '') return undefined;
  if (plain.length <= DESCRIPTION_MAX) return plain;
  return `${plain.slice(0, DESCRIPTION_MAX - 3).replace(/\s+\S*$/, '')}...`;
}

/** Front matter plus the body of one page; a page the site cannot title or describe is an error. */
function stagePage(path: string, text: string): string {
  const supplied = SUPPLIED_PAGES[path];
  const source = supplied ? `# ${supplied.title}\n\n${supplied.intro}\n\n${text}` : text;
  const title = pageTitle(source);
  if (title === undefined) throw new Error(`${path}: no H1 and no supplied title`);
  const description = firstParagraph(source);
  if (description === undefined) throw new Error(`${path}: no opening paragraph for a description`);
  return wrapLiquid(`${frontMatter(title, description)}${rewriteMarkdownLinks(source, path)}`);
}

/** llms.txt is read off the site, so its repo-relative links become absolute Pages or GitHub URLs. */
function llmsLink(href: string): string {
  if (/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(href)) return href;
  if (href === 'README.md') return `${PAGES_BASE}/`;
  if (isDocsPage(href)) return `${PAGES_BASE}/${href.replace(/\.md$/, '.html')}`;
  return `${GITHUB}/blob/master/${href}`;
}

const rewriteLlms = (text: string): string =>
  text.replace(/\]\(([^)\s]+)\)/g, (_m, href: string) => `](${llmsLink(href)})`);

function jekyllConfig(root: string): string {
  const manifest: { description: string } = JSON.parse(
    readFileSync(join(root, 'packages/cli/package.json'), 'utf8'),
  );
  const verification = process.env['GOOGLE_SITE_VERIFICATION'];
  return stringify({
    title: 'vetkit',
    tagline: TAGLINE,
    description: manifest.description,
    url: PAGES_HOST,
    baseurl: '/vetkit',
    logo: `${PAGES_BASE}/assets/logo.png`,
    ...(verification ? { google_site_verification: verification } : {}),
    plugins: ['jekyll-seo-tag', 'jekyll-sitemap'],
    defaults: [
      { scope: { path: '' }, values: { image: `${PAGES_BASE}/assets/social-preview.png` } },
    ],
  });
}

function lintPage(): string {
  const sections = LINT_RULES.map((rule) => {
    const anchor = rule.id.toLowerCase().replaceAll('_', '-');
    return `## ${rule.id} {#${anchor}}\n\nSeverity: ${rule.severity}\n\n${rule.why}\n`;
  });
  const intro =
    'Every rule `vet lint` applies to criteria.yaml, with its severity and the reason for it.\n';
  return `# Lint rules\n\n${intro}\n${sections.join('\n')}`;
}

function migratePage(): string {
  const versions = Object.entries(SCHEMA_VERSIONS).map(
    ([format, version]) => `- ${format}: ${String(version)}`,
  );
  const changes = SCHEMA_CHANGELOG.map(
    (change) => `- ${change.format} ${String(change.version)}: ${change.summary}`,
  );
  return [
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
function planSite(root: string): Map<string, string | Buffer> {
  const site = new Map<string, string | Buffer>();
  site.set('_config.yml', jekyllConfig(root));
  site.set('index.md', stagePage('README.md', readFileSync(join(root, 'README.md'), 'utf8')));
  for (const path of gitFiles(root, 'docs').filter(isDocsPage))
    site.set(path, stagePage(path, readFileSync(join(root, path), 'utf8')));
  site.set('docs/lint.md', stagePage('docs/lint.md', lintPage()));
  site.set('docs/migrate.md', stagePage('docs/migrate.md', migratePage()));
  for (const schema of schemaFiles(root))
    site.set(schema.id.slice(PAGES_BASE.length + 1), schema.text);
  for (const asset of ASSETS) site.set(asset, readFileSync(join(root, asset)));
  if (existsSync(join(root, 'llms.txt')))
    site.set('llms.txt', rewriteLlms(readFileSync(join(root, 'llms.txt'), 'utf8')));
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
