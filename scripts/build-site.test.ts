import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
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
const frontMatterTitle = (text: string): string | undefined =>
  /^---\ntitle: (.+)\n---\n/.exec(text)?.[1];
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

describe('site staging', () => {
  it('writes the Jekyll config', () => {
    const config: Record<string, unknown> = parse(staged('_config.yml'));
    expect(config).toMatchObject({
      title: 'vetkit',
      baseurl: '/vetkit',
      url: 'https://melsovcozy.github.io',
    });
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

  it('takes the page title from the first heading, or the file name when there is none', () => {
    expect(frontMatterTitle(staged('docs/watch.md'))).toBe(JSON.stringify('`vet watch`'));
    expect(frontMatterTitle(staged('docs/guides/cli-json.md'))).toBe(JSON.stringify('cli-json'));
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

  it('copies the root llms.txt to the site root', () => {
    expect(staged('llms.txt')).toBe(readFileSync(join(ROOT, 'llms.txt'), 'utf8'));
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
  steps?: { uses?: string; run?: string; if?: string; with?: Record<string, string> }[];
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

  it('grants write permissions to the deploy job only', () => {
    for (const [name, job] of Object.entries(doc.jobs)) {
      const writes = Object.values(job.permissions ?? {}).filter((v) => v === 'write');
      expect(writes.length > 0, name).toBe(name === 'deploy');
    }
  });
});
