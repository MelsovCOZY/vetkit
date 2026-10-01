import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LINT_RULES, MIGRATE_DOCS, SCHEMA_CHANGELOG, SCHEMA_VERSIONS } from '@vetkit/core';
import { parse } from 'yaml';
import {
  collectPagesUrls,
  liveCheckPlan,
  rewriteLink,
  stageSite,
  wrapLiquid,
} from './build-site.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGES = 'https://melsovcozy.github.io/vetkit';
const GITHUB = 'https://github.com/MelsovCOZY/vetkit';

let out = '';
beforeAll(() => {
  out = mkdtempSync(join(tmpdir(), 'vetkit-site-'));
  stageSite(ROOT, out);
});
afterAll(() => {
  rmSync(out, { recursive: true, force: true });
});

const staged = (path: string): string => readFileSync(join(out, path), 'utf8');
const tracked = (...patterns: string[]): string[] =>
  execFileSync('git', ['ls-files', '-z', ...patterns], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter((path) => path !== '');
interface FrontMatter {
  title?: unknown;
  description?: unknown;
}
const frontMatter = (text: string): FrontMatter => {
  const block = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1];
  return block === undefined ? {} : parse(block);
};
const frontMatterTitle = (text: string): unknown => frontMatter(text).title;
const pageBody = (text: string): string =>
  text
    .replace(/^---\n[\s\S]*?\n---\n/, '')
    .replace(/^\{% raw %\}\n/, '')
    .replace(/\{% endraw %\}\n$/, '');
const cliDescription = (): string => {
  const manifest: { description: string } = JSON.parse(
    readFileSync(join(ROOT, 'packages/cli/package.json'), 'utf8'),
  );
  return manifest.description;
};
const idOf = (text: string): string => {
  const schema: { $id: string } = JSON.parse(text);
  return schema.$id;
};
const byName = (a: string, b: string): number => a.localeCompare(b);
const lintAnchor = (id: string): string => id.toLowerCase().replaceAll('_', '-');

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

// A throwaway git repository holding the files staging always reads plus the given pages, so a
// staging rule can be checked against a tree the real docs do not have.
function fixtureRepo(pages: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'vetkit-site-fixture-'));
  const copied = [
    'README.md',
    'packages/cli/package.json',
    'packages/source-otlp/src/reader/otlp.schema.json',
    'assets/logo.png',
    'assets/social-preview.png',
  ];
  for (const file of copied) {
    mkdirSync(join(root, dirname(file)), { recursive: true });
    copyFileSync(join(ROOT, file), join(root, file));
  }
  for (const [file, text] of Object.entries(pages)) {
    mkdirSync(join(root, dirname(file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '-A'], { cwd: root });
  return root;
}

describe('site staging', () => {
  it('writes the Jekyll config with the seo and sitemap plugins, the logo and the social image', () => {
    const config: Record<string, unknown> = parse(staged('_config.yml'));
    expect(config).toMatchObject({
      title: 'vetkit',
      baseurl: '/vetkit',
      url: 'https://melsovcozy.github.io',
      description: cliDescription(),
      logo: `${PAGES}/assets/logo.png`,
      plugins: ['jekyll-seo-tag', 'jekyll-sitemap'],
      defaults: [{ scope: { path: '' }, values: { image: `${PAGES}/assets/social-preview.png` } }],
    });
    expect(typeof config['tagline']).toBe('string');
    expect(String(config['tagline']).trim()).not.toBe('');
    expect(config).not.toHaveProperty('google_site_verification');
  });

  it('emits google_site_verification only when GOOGLE_SITE_VERIFICATION is set', () => {
    const verified = mkdtempSync(join(tmpdir(), 'vetkit-site-verified-'));
    process.env['GOOGLE_SITE_VERIFICATION'] = 'token-for-search-console';
    try {
      stageSite(ROOT, verified);
      const config: Record<string, unknown> = parse(
        readFileSync(join(verified, '_config.yml'), 'utf8'),
      );
      expect(config['google_site_verification']).toBe('token-for-search-console');
    } finally {
      delete process.env['GOOGLE_SITE_VERIFICATION'];
      rmSync(verified, { recursive: true, force: true });
    }
  });

  it('copies the logo and the social preview image under assets/', () => {
    for (const file of ['assets/logo.png', 'assets/social-preview.png']) {
      expect(readFileSync(join(out, file)).equals(readFileSync(join(ROOT, file))), file).toBe(true);
    }
  });

  it('gives every staged page a title and a plain-text description of at most 160 chars taken from its first paragraph', () => {
    const pages = walk(out).filter((path) => path.endsWith('.md'));
    expect(pages.length).toBeGreaterThan(5);
    for (const page of pages) {
      const { title, description } = frontMatter(readFileSync(page, 'utf8'));
      expect(typeof title, page).toBe('string');
      expect(String(title).trim(), page).not.toBe('');
      expect(typeof description, page).toBe('string');
      const text = String(description);
      expect(text.trim(), page).toBe(text);
      expect(text.length, page).toBeGreaterThan(0);
      expect(text.length, page).toBeLessThanOrEqual(160);
      expect(text, page).not.toMatch(/[\n`<>]|\]\(|^#|\*\*/);
    }
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8').split('\n');
    const paragraph = readme.find((line) => line.trim() !== '' && !/^[#<[!|]/.test(line));
    expect(paragraph).toBeDefined();
    expect(frontMatter(staged('index.md')).description).toBe(paragraph?.trim());
    expect(frontMatter(staged('docs/sinks.md')).description).toMatch(
      /^A sink writes verdicts back to an observability backend/,
    );
  });

  it('stages README.md as index.md with front matter', () => {
    const index = staged('index.md');
    expect(frontMatterTitle(index)).toBeDefined();
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    const lines = readme.split('\n');
    const heading = lines.find((line) => line.startsWith('# '));
    expect(heading).toBeDefined();
    expect(index).toContain(heading);
    const body = lines.find(
      (line) => line.trim().length > 20 && !line.startsWith('#') && !line.includes('assets/'),
    );
    expect(body).toBeDefined();
    expect(index).toContain(body);
    if (/\{\{|\{%/.test(readme)) expect(index).toContain('{% raw %}');
    expect(index).not.toContain('src="assets/logo.png"');
    if (readme.includes('src="assets/logo.png"')) {
      expect(index).toContain(
        `src="https://raw.githubusercontent.com/MelsovCOZY/vetkit/master/assets/logo.png"`,
      );
    }
  });

  it('stages every tracked top-level docs page', () => {
    const pages = tracked('docs').filter((path) => /^docs\/(guides\/)?[^/]+\.md$/.test(path));
    expect(pages).toEqual(
      expect.arrayContaining(['docs/configuration.md', 'docs/sinks.md', 'docs/watch.md']),
    );
    for (const page of pages) {
      expect(frontMatterTitle(staged(page)), page).toBeDefined();
    }
    expect(existsSync(join(out, 'docs/contracts'))).toBe(false);
    expect(existsSync(join(out, 'docs/listings'))).toBe(false);
  });

  it('takes the page title from the first heading', () => {
    expect(frontMatterTitle(staged('docs/watch.md'))).toBe('`vet watch`');
  });

  it('supplies the title and opening paragraph of a page that has no heading, so no title is ever a file name', () => {
    for (const page of tracked('docs').filter((path) =>
      /^docs\/(guides\/)?[^/]+\.md$/.test(path),
    )) {
      if (!existsSync(join(out, page))) continue;
      expect(frontMatterTitle(staged(page)), page).not.toBe(posix.basename(page, '.md'));
    }
    const cliJson = staged('docs/guides/cli-json.md');
    const title = String(frontMatterTitle(cliJson));
    expect(title).toMatch(/\bvet\b/);
    expect(title).toMatch(/JSON/);
    const lines = pageBody(cliJson).split('\n');
    expect(lines[0]).toBe(`# ${title}`);
    expect(lines[1]).toBe('');
    expect(lines[2]?.trim()).toBe(frontMatter(cliJson).description);
    expect(lines.indexOf('## --version')).toBeGreaterThan(2);
  });

  it('refuses to stage a page that has neither a heading nor a supplied title', () => {
    const root = fixtureRepo({ 'docs/untitled.md': 'Some words with no heading.\n' });
    const dest = mkdtempSync(join(tmpdir(), 'vetkit-site-untitled-'));
    try {
      expect(() => stageSite(root, dest)).toThrow(/docs\/untitled\.md/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(dest, { recursive: true, force: true });
    }
  });

  it('never stages the internal INDEX.md map under docs', () => {
    const indexPath = posix.join('docs', 'INDEX.md');
    expect(existsSync(join(out, indexPath))).toBe(false);
    const root = fixtureRepo({
      [indexPath]: '# Index\n\nInternal map of the docs tree.\n',
      'docs/kept.md': '# Kept\n\nA public page.\n',
    });
    const dest = mkdtempSync(join(tmpdir(), 'vetkit-site-index-'));
    try {
      stageSite(root, dest);
      expect(existsSync(join(dest, 'docs/kept.md'))).toBe(true);
      expect(existsSync(join(dest, indexPath))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(dest, { recursive: true, force: true });
    }
  });

  it('copies every spec schema and the otlp schema to the path its $id names', () => {
    const files = [
      ...tracked('packages/spec/schemas').filter((path) => path.endsWith('.schema.json')),
      'packages/source-otlp/src/reader/otlp.schema.json',
    ];
    expect(files.length).toBeGreaterThan(8);
    for (const file of files) {
      const text = readFileSync(join(ROOT, file), 'utf8');
      const id = idOf(text);
      expect(id.startsWith(`${PAGES}/`), id).toBe(true);
      expect(staged(id.slice(PAGES.length + 1)), id).toBe(text);
    }
  });

  it('generates a lint page with an anchor for every LINT_RULES id', () => {
    const lint = staged('docs/lint.md');
    expect(frontMatterTitle(lint)).toBeDefined();
    for (const rule of LINT_RULES) {
      expect(lint).toContain(`## ${rule.id} {#${lintAnchor(rule.id)}}`);
      expect(lint).toContain(rule.severity);
      expect(lint).toContain(rule.why);
      expect(rule.docs).toBe(`${PAGES}/docs/lint.html#${lintAnchor(rule.id)}`);
    }
  });

  it('generates a migrate page from SCHEMA_VERSIONS', () => {
    const migrate = staged('docs/migrate.md');
    expect(frontMatterTitle(migrate)).toBeDefined();
    for (const [format, version] of Object.entries(SCHEMA_VERSIONS)) {
      expect(migrate).toContain(`${format}: ${String(version)}`);
    }
    for (const change of SCHEMA_CHANGELOG) {
      expect(migrate).toContain(change.summary);
    }
    expect(migrate).toContain('vet migrate --check');
    expect(migrate).toMatch(/`vet migrate`/);
    expect(MIGRATE_DOCS).toBe(`${PAGES}/docs/migrate.html`);
  });

  it('stages llms.txt unchanged apart from its links, which become absolute Pages or GitHub URLs', () => {
    const source = readFileSync(join(ROOT, 'llms.txt'), 'utf8');
    const stagedText = staged('llms.txt');
    const link = /\]\(([^)\s]+)\)/g;
    expect(stagedText.replace(link, '](#)')).toBe(source.replace(link, '](#)'));
    const sourceTargets = [...source.matchAll(link)].map((m) => m[1] ?? '');
    const stagedTargets = [...stagedText.matchAll(link)].map((m) => m[1] ?? '');
    expect(sourceTargets.length).toBeGreaterThan(5);
    expect(stagedTargets).toHaveLength(sourceTargets.length);
    expect(sourceTargets.some((t) => t.startsWith('docs/'))).toBe(true);
    expect(sourceTargets.some((t) => /^(packages|skills|examples)\//.test(t))).toBe(true);
    const urls = collectPagesUrls(ROOT);
    for (const [i, target] of sourceTargets.entries()) {
      const rewritten = stagedTargets[i] ?? '';
      if (/^https?:/.test(target)) {
        expect(rewritten, target).toBe(target);
      } else if (/^docs\/(guides\/)?[^/]+\.md$/.test(target)) {
        expect(rewritten, target).toBe(`${PAGES}/${target.replace(/\.md$/, '.html')}`);
        expect(urls, target).toContain(rewritten);
      } else if (target === 'README.md') {
        expect(rewritten, target).toBe(`${PAGES}/`);
      } else {
        expect(rewritten, target).toBe(`${GITHUB}/blob/master/${target}`);
      }
    }
  });

  it('every relative link in the staged tree resolves to a staged file', () => {
    const pages = walk(out).filter((path) => path.endsWith('.md'));
    expect(pages.length).toBeGreaterThan(5);
    const broken: string[] = [];
    for (const page of pages) {
      const rel = page.slice(out.length + 1);
      const text = readFileSync(page, 'utf8');
      const links = [
        ...[...text.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1] ?? ''),
        ...[...text.matchAll(/\b(?:src|href)="([^"]+)"/g)].map((m) => m[1] ?? ''),
      ];
      for (const link of links) {
        if (/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(link)) continue;
        const target = posix.join(posix.dirname(rel), link.split('#')[0] ?? '');
        const candidates = [target, target.replace(/\.html$/, '.md')];
        if (target === '.' || target === '') candidates.push('index.md');
        if (!candidates.some((c) => existsSync(join(out, c)))) broken.push(`${rel} -> ${link}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('no staged page holds an unguarded liquid tag', () => {
    for (const page of walk(out).filter((path) => path.endsWith('.md'))) {
      const text = readFileSync(page, 'utf8');
      const unguarded = text.replace(/\{% raw %\}[\s\S]*?\{% endraw %\}/g, '').match(/\{\{|\{%/);
      expect(unguarded, page).toBeNull();
    }
  });
});

describe('wrapLiquid', () => {
  it('wraps a page that holds a liquid delimiter, after its front matter', () => {
    const page = '---\ntitle: "x"\n---\nuse {{ name }} here\n';
    expect(wrapLiquid(page)).toBe(
      '---\ntitle: "x"\n---\n{% raw %}\nuse {{ name }} here\n{% endraw %}\n',
    );
    const tag = '---\ntitle: "x"\n---\n{% if a %}\n';
    expect(wrapLiquid(tag)).toContain('{% raw %}');
  });

  it('leaves a page without liquid delimiters unchanged', () => {
    const page = '---\ntitle: "x"\n---\nplain {#id}\n';
    expect(wrapLiquid(page)).toBe(page);
  });
});

describe('rewriteLink', () => {
  it('points a docs page at its html twin, relative to the linking page', () => {
    expect(rewriteLink('docs/x.md', 'README.md')).toBe('docs/x.html');
    expect(rewriteLink('./otlp-http-json.md#top', 'docs/guides/cli-json.md')).toBe(
      'otlp-http-json.html#top',
    );
    expect(rewriteLink('../sinks.md', 'docs/guides/cli-json.md')).toBe('../sinks.html');
  });

  it('points package paths and contracts at the repository on GitHub', () => {
    expect(rewriteLink('packages/cli', 'README.md')).toBe(`${GITHUB}/tree/master/packages/cli`);
    expect(rewriteLink('contracts/j7.md', 'docs/watch.md')).toBe(
      `${GITHUB}/blob/master/docs/contracts/j7.md`,
    );
    expect(rewriteLink('../contracts/j7.md', 'docs/guides/x.md')).toBe(
      `${GITHUB}/blob/master/docs/contracts/j7.md`,
    );
  });

  it('points assets at raw.githubusercontent.com', () => {
    expect(rewriteLink('assets/logo.png', 'README.md')).toBe(
      'https://raw.githubusercontent.com/MelsovCOZY/vetkit/master/assets/logo.png',
    );
  });

  it('leaves absolute urls, mail links and bare anchors alone', () => {
    for (const href of ['https://example.com/a', 'mailto:a@b.c', '#section']) {
      expect(rewriteLink(href, 'README.md')).toBe(href);
    }
  });
});

describe('collectPagesUrls', () => {
  it('includes every $id, lint link, MIGRATE_DOCS and homepage', () => {
    const urls = collectPagesUrls(ROOT);
    for (const file of tracked('packages/spec/schemas').filter((p) => p.endsWith('.schema.json'))) {
      const id = idOf(readFileSync(join(ROOT, file), 'utf8'));
      expect(urls, id).toContain(id);
    }
    const otlpId = idOf(
      readFileSync(join(ROOT, 'packages/source-otlp/src/reader/otlp.schema.json'), 'utf8'),
    );
    expect(urls).toContain(otlpId);
    for (const rule of LINT_RULES) expect(urls).toContain(rule.docs);
    expect(urls).toContain(MIGRATE_DOCS);
    expect(urls).toContain(`${PAGES}/`);
    expect(urls).toContain(`${PAGES}/docs/lint.html`);
    expect(urls.every((url) => url.startsWith(`${PAGES}/`))).toBe(true);
  });

  it('leaves out the source-jsonl inline ids, which are registration keys and not files', () => {
    expect(collectPagesUrls(ROOT).some((url) => url.includes('source-jsonl'))).toBe(false);
  });
});

describe('liveCheckPlan', () => {
  it('skips with the logged reason when the repo is private', () => {
    expect(liveCheckPlan(true)).toEqual({
      check: false,
      message:
        'link-check: skipped (repository is private; the Pages host resolves only after the repo is public)',
    });
  });

  it('checks when the repo is public', () => {
    expect(liveCheckPlan(false).check).toBe(true);
  });
});

interface Job {
  needs?: string | string[];
  if?: string;
  permissions?: Record<string, string>;
  outputs?: Record<string, string>;
  steps?: {
    uses?: string;
    run?: string;
    if?: string;
    with?: Record<string, string>;
    env?: Record<string, string>;
  }[];
}
interface Workflow {
  on?: { push?: { branches?: string[] } };
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
}

describe('pages workflow', () => {
  const text = readFileSync(join(ROOT, '.github/workflows/pages.yml'), 'utf8');
  const doc: Workflow = parse(text);

  it('pages.yml gates deploy and live link check on repository visibility', () => {
    expect(doc.on?.push?.branches).toEqual(['master']);
    expect(doc.permissions).toEqual({ contents: 'read' });
    expect(Object.keys(doc.jobs).toSorted()).toEqual([
      'build',
      'deploy',
      'link-check',
      'visibility',
    ]);

    expect(doc.jobs['visibility']?.outputs).toHaveProperty('private');
    expect(text).toContain('gh api repos/MelsovCOZY/vetkit --jq .private');

    const deploy = doc.jobs['deploy'];
    expect([deploy?.needs ?? []].flat().toSorted(byName)).toEqual(['build', 'visibility']);
    expect(deploy?.if).toContain("needs.visibility.outputs.private == 'false'");
    expect(deploy?.permissions).toEqual({ pages: 'write', 'id-token': 'write' });
    const deployUses = (deploy?.steps ?? []).map((s) => s.uses?.split('@')[0]);
    expect(deployUses).toEqual(['actions/configure-pages', 'actions/deploy-pages']);

    const linkCheck = doc.jobs['link-check'];
    expect([linkCheck?.needs ?? []].flat().toSorted(byName)).toEqual(['deploy', 'visibility']);
    expect(linkCheck?.if).toBe('always()');
    expect(text).toContain(liveCheckPlan(true).message);
    expect(text).toContain('bun scripts/build-site.ts --check-live');
  });

  it('the build job stages, tests, builds with Jekyll and uploads the site', () => {
    const steps = doc.jobs['build']?.steps ?? [];
    const runs = steps.map((s) => s.run ?? '').join('\n');
    expect(runs).toContain('bun install --frozen-lockfile');
    expect(runs).toContain('bun run build');
    expect(runs).toContain('bun scripts/build-site.ts site-src');
    expect(runs).toContain('bun x vitest run scripts/build-site.test.ts');
    const jekyll = steps.find((s) => s.uses?.startsWith('actions/jekyll-build-pages@'));
    expect(jekyll?.with?.['source']).toBe('site-src');
    expect(steps.some((s) => s.uses?.startsWith('actions/upload-pages-artifact@'))).toBe(true);
  });

  it('the stage step receives the Search Console token from the GOOGLE_SITE_VERIFICATION variable', () => {
    const steps = doc.jobs['build']?.steps ?? [];
    const stage = steps.find((s) => s.run?.includes('bun scripts/build-site.ts site-src'));
    expect(stage?.env?.['GOOGLE_SITE_VERIFICATION']).toBe('${{ vars.GOOGLE_SITE_VERIFICATION }}');
  });

  it('grants write permissions to the deploy job only', () => {
    for (const [name, job] of Object.entries(doc.jobs)) {
      const writes = Object.values(job.permissions ?? {}).filter((v) => v === 'write');
      expect(writes.length > 0, name).toBe(name === 'deploy');
    }
  });
});
