import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import {
  extractSnippets,
  populateNodeModules,
  rewriteInstall,
  sameInstall,
  scratchManifest,
} from './readme-snippets.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER = join(ROOT, 'scripts', 'examples-run.sh');
const SAMPLE = join(ROOT, 'scripts', 'fixtures', 'readme-snippets', 'sample.md');

const KEY_VARS = [
  'AI_GATEWAY_API_KEY',
  'OPENROUTER_API_KEY',
  'TYPESAFE_API_KEY',
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID',
];

/** A tiny template project with one dependency, a .bin link and npm's hidden lockfile. */
function linkFixture(): { template: string; scratch: string } {
  const base = mkdtempSync(join(tmpdir(), 'vetkit-link-test-'));
  const template = join(base, 'template');
  const scratch = join(base, 'scratch');
  mkdirSync(join(template, 'node_modules', 'dep', 'nested'), { recursive: true });
  mkdirSync(join(template, 'node_modules', '.bin'), { recursive: true });
  writeFileSync(join(template, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n');
  writeFileSync(join(template, 'node_modules', 'dep', 'nested', 'deep.js'), 'deep\n');
  writeFileSync(join(template, 'node_modules', '.package-lock.json'), '{"lock":true}\n');
  symlinkSync('../dep/index.js', join(template, 'node_modules', '.bin', 'dep'));
  mkdirSync(scratch);
  return { template, scratch };
}

function inode(path: string): number {
  return statSync(path).ino;
}

describe('examples-run.sh', () => {
  it('examples-run.sh fails fast naming a missing tarball dir', () => {
    const bogus = join(ROOT, 'no-such-tarball-dir-for-test');
    const result = spawnSync('bash', [RUNNER, bogus], { cwd: ROOT, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(bogus);
  });

  it('examples-run.sh unsets every judge and generator key var before npm test', () => {
    const source = readFileSync(RUNNER, 'utf8');
    const unsetLines = source.split('\n').filter((line) => /^\s*unset\b/.test(line));
    expect(unsetLines.length).toBeGreaterThan(0);
    for (const name of KEY_VARS) {
      expect(
        unsetLines.some((line) => line.includes(name)),
        name,
      ).toBe(true);
    }
    expect(source.indexOf('unset')).toBeLessThan(source.indexOf('npm test'));
  });

  it('examples-run.sh parses under bash -n', () => {
    const result = spawnSync('bash', ['-n', RUNNER], { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});

describe('examples/', () => {
  const examplesDir = join(ROOT, 'examples');
  const names = existsSync(examplesDir)
    ? readdirSync(examplesDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    : [];

  it('every examples/*/package.json is private, has scripts.test and no key value', () => {
    expect(names).toContain('jsonl');
    for (const name of names) {
      const text = readFileSync(join(examplesDir, name, 'package.json'), 'utf8');
      const pkg: { private?: boolean; scripts?: Record<string, string> } = JSON.parse(text);
      expect(pkg.private, `${name} private`).toBe(true);
      expect(typeof pkg.scripts?.['test'], `${name} scripts.test`).toBe('string');
      expect(text, `${name} key value`).not.toMatch(/sk-[A-Za-z0-9_-]{16,}/);
      for (const keyVar of KEY_VARS) {
        expect(text, `${name} ${keyVar}`).not.toMatch(new RegExp(`${keyVar}["']?\\s*[:=]`));
      }
    }
  });

  it('examples/jsonl has the documented deliverables', () => {
    const dir = join(examplesDir, 'jsonl');
    for (const file of [
      'evals/criteria.yaml',
      'evals/cases/support.jsonl',
      'vetkit.config.ts',
      'README.md',
      '.env.example',
    ]) {
      expect(existsSync(join(dir, file)), file).toBe(true);
    }
    const pkg: { scripts: Record<string, string> } = JSON.parse(
      readFileSync(join(dir, 'package.json'), 'utf8'),
    );
    expect(pkg.scripts['test']).toBe('vet run --json && vet estimate --json');
    const criteria: { criteria: unknown[] } = parse(
      readFileSync(join(dir, 'evals/criteria.yaml'), 'utf8'),
    );
    expect(criteria.criteria).toHaveLength(2);
    const cases = readFileSync(join(dir, 'evals/cases/support.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '');
    expect(cases.length).toBeGreaterThanOrEqual(4);
    const traces = readdirSync(join(dir, 'traces')).filter((file) => file.endsWith('.jsonl'));
    expect(traces).toHaveLength(2);
    const readme = readFileSync(join(dir, 'README.md'), 'utf8');
    expect(readme).toContain('vet run');
    expect(readme).toContain('<!-- snippet: skip reason="needs a generator key" -->');
    expect(readme).toContain('vet init --source jsonl:traces --out evals-generated');
  });
});

describe('readme-snippets', () => {
  const markdown = readFileSync(SAMPLE, 'utf8');
  const lines = markdown.split('\n');
  const lineOf = (needle: string): number => lines.findIndex((line) => line === needle) + 1;
  const snippets = extractSnippets(markdown);
  const at = (fenceLine: number) => snippets.find((snippet) => snippet.line === fenceLine);

  it('readme-snippets: extracts fences with directives from a fixture README', () => {
    expect(at(lineOf('```sh'))).toMatchObject({
      lang: 'sh',
      code: 'echo plain',
      action: 'run',
      env: {},
    });
    expect(at(lineOf('```ts'))).toMatchObject({ action: 'write', file: 'vetkit.config.ts' });
    expect(at(lineOf('```bash'))).toMatchObject({
      action: 'skip',
      reason: 'needs a generator key',
    });
    const envBlock = snippets.find((snippet) => snippet.code.includes('$GREETING'));
    expect(envBlock).toMatchObject({ action: 'run', env: { GREETING: 'hello' } });
    const plainTs = snippets.find((snippet) => snippet.code === "console.log('ts');");
    expect(plainTs).toMatchObject({ lang: 'ts', action: 'run', env: {} });
    const yaml = snippets.find((snippet) => snippet.lang === 'yaml');
    expect(yaml?.action).toBe('error');
    expect(yaml?.error).toBe('yaml/json block needs snippet: file=');
    const escape = snippets.find((snippet) => snippet.lang === 'json');
    expect(escape?.action).toBe('error');
    expect(escape?.error).toContain('..');
  });

  it('readme-snippets: ignores unknown info strings and fences inside HTML comments', () => {
    expect(snippets.some((snippet) => snippet.code.includes('not a snippet'))).toBe(false);
    expect(snippets.some((snippet) => snippet.code.includes('inside-a-comment'))).toBe(false);
  });

  it('readme-snippets: a skip directive without a reason is an error, not a silent skip', () => {
    const out = extractSnippets('<!-- snippet: skip -->\n```sh\necho x\n```\n');
    expect(out).toHaveLength(1);
    expect(out[0]?.action).toBe('error');
  });

  it('readme-snippets: CRLF input and a README with no snippets are handled', () => {
    expect(extractSnippets('# none\r\n\r\ntext\r\n')).toEqual([]);
    const crlf = extractSnippets('```sh\r\necho a\r\n```\r\n');
    expect(crlf[0]?.code).toBe('echo a');
  });

  it('readme-snippets: rewrites npm i lines to no-ops for tarball packages and fails on unknown packages', () => {
    const tarballs = ['vetkit', '@vetkit/core', '@vetkit/scorers'];
    expect(rewriteInstall('npm i -D vetkit', tarballs)).toBe('true');
    expect(rewriteInstall('npm install --save-dev vetkit @vetkit/scorers vitest', tarballs)).toBe(
      'true',
    );
    expect(rewriteInstall('pnpm add -D vetkit promptfoo', tarballs)).toBe('true');
    expect(rewriteInstall('bun add vetkit', tarballs)).toBe('true');
    expect(rewriteInstall('npm add vitest@5.0.2', tarballs)).toBe('true');
    expect(rewriteInstall('echo hello', tarballs)).toBe('echo hello');
    expect(() => rewriteInstall('npm i -D vetkit left-pad', tarballs)).toThrow('left-pad');
    expect(() => rewriteInstall('npm i ai', tarballs)).toThrow('ai');
  });

  it('readme-snippets: a scratch manifest with the template dependency set skips its own install', () => {
    const tarballs = { vetkit: '/t/vetkit.tgz', '@vetkit/core': '/t/core.tgz' };
    const template = scratchManifest({}, tarballs, '5.0.2');
    expect(sameInstall(scratchManifest({}, tarballs, '5.0.2'), template)).toBe(true);
    // Only what npm installs counts: a different name or scripts is still the same install.
    const renamed = { ...template, name: 'other', scripts: { test: 'vet run' } };
    expect(sameInstall(renamed, template)).toBe(true);
    const extraDep = scratchManifest({ dependencies: { ai: '5.0.270' } }, tarballs, '5.0.2');
    expect(sameInstall(extraDep, template)).toBe(false);
    const extraDev = scratchManifest(
      { devDependencies: { typescript: '7.0.2', vitest: '^5.0.2' } },
      tarballs,
      '5.0.2',
    );
    expect(sameInstall(extraDev, template)).toBe(false);
    const otherTarballs = scratchManifest(
      {},
      { ...tarballs, '@vetkit/spec': '/t/spec.tgz' },
      '5.0.2',
    );
    expect(sameInstall(otherTarballs, template)).toBe(false);
  });

  describe('populateNodeModules', () => {
    it('hard-links every file of the template node_modules and copies the hidden lockfile', () => {
      const { template, scratch } = linkFixture();
      try {
        expect(populateNodeModules(template, scratch)).toBe('linked');
        const from = join(template, 'node_modules');
        const to = join(scratch, 'node_modules');
        expect(readFileSync(join(to, 'dep', 'index.js'), 'utf8')).toBe('module.exports = 1;\n');
        expect(inode(join(to, 'dep', 'index.js'))).toBe(inode(join(from, 'dep', 'index.js')));
        expect(inode(join(to, 'dep', 'nested', 'deep.js'))).toBe(
          inode(join(from, 'dep', 'nested', 'deep.js')),
        );
        expect(readFileSync(join(to, '.bin', 'dep'), 'utf8')).toBe('module.exports = 1;\n');
        // npm rewrites the hidden lockfile in place, so a shared inode would corrupt the template.
        expect(readFileSync(join(to, '.package-lock.json'), 'utf8')).toBe('{"lock":true}\n');
        expect(inode(join(to, '.package-lock.json'))).not.toBe(
          inode(join(from, '.package-lock.json')),
        );
      } finally {
        rmSync(dirname(template), { recursive: true, force: true });
      }
    });

    it('falls back to a recursive copy when linking fails', () => {
      const { template, scratch } = linkFixture();
      const path = process.env['PATH'];
      process.env['PATH'] = join(scratch, 'no-such-bin');
      try {
        expect(populateNodeModules(template, scratch)).toBe('copied');
        const from = join(template, 'node_modules');
        const to = join(scratch, 'node_modules');
        expect(readFileSync(join(to, 'dep', 'nested', 'deep.js'), 'utf8')).toBe('deep\n');
        expect(inode(join(to, 'dep', 'index.js'))).not.toBe(inode(join(from, 'dep', 'index.js')));
        expect(readFileSync(join(to, '.package-lock.json'), 'utf8')).toBe('{"lock":true}\n');
      } finally {
        process.env['PATH'] = path;
        rmSync(dirname(template), { recursive: true, force: true });
      }
    });
  });
});

describe('ci.yml', () => {
  it('ci.yml examples job needs check-build-pack, downloads dist-tarballs-22 and runs both runners', () => {
    const workflow: {
      jobs: Record<
        string,
        {
          needs?: string | string[];
          strategy?: { matrix?: { node?: unknown[] } };
          steps: { uses?: string; with?: Record<string, unknown>; run?: string }[];
        }
      >;
    } = parse(readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8'));
    const job = workflow.jobs['examples'];
    expect(job).toBeDefined();
    const needs = [job?.needs ?? []].flat();
    expect(needs).toContain('check-build-pack');
    const steps = job?.steps ?? [];
    const download = steps.find((step) => step.uses?.startsWith('actions/download-artifact@'));
    expect(download?.with?.['name']).toBe('dist-tarballs-22');
    const runs = steps.map((step) => step.run ?? '');
    expect(runs.some((run) => run.includes('bash scripts/examples-run.sh dist-tarballs'))).toBe(
      true,
    );
    expect(runs.some((run) => run.includes('bun scripts/readme-snippets.ts dist-tarballs'))).toBe(
      true,
    );
    expect(job?.strategy?.matrix?.node ?? [22]).toEqual([22]);
  });
});
