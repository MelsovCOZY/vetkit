import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintCriteria, loadCases, loadCriteria, runEvals } from '@vetkit/core';
import { JEV_CREDENTIAL_PRIORITY, JEV_PRESETS } from '@vetkit/judge-jev';
import { safeParseJson } from '@vetkit/spec';
import { beforeAll, describe, expect, test } from 'vitest';
import { loadVetConfig } from '../config-load.ts';
import { demoJudge } from '../demo-judge.ts';
import { ensureCliBuilt } from '../test-support/build-cli.js';
import { renderConfig } from './init.ts';

const binPath = fileURLToPath(new URL('../../dist/bin.js', import.meta.url));
const fakeJudgeConfig = fileURLToPath(
  new URL('../../../../fixtures/cli/run/vetkit.config.ts', import.meta.url),
);
const templateCriteria = fileURLToPath(new URL('../../templates/criteria.yaml', import.meta.url));
const templatesDir = fileURLToPath(new URL('../../templates/', import.meta.url));
const cliPackageDir = fileURLToPath(new URL('../../', import.meta.url));

const TARGETS = ['vetkit.config.ts', 'evals/criteria.yaml', 'evals/cases/example.jsonl'] as const;
const CREDENTIAL_NAMES = JEV_CREDENTIAL_PRIORITY.flatMap((p) =>
  JEV_PRESETS[p].credentials.map((c) => c.name),
);

beforeAll(async () => {
  await ensureCliBuilt();
}, 180_000);

interface Result {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number | null;
}

// The runner's own judge keys never reach the child: each test sets exactly the ones it needs.
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
  for (const name of CREDENTIAL_NAMES) delete env[name];
  delete env['CI'];
  return { ...env, ...extra };
}

function runVet(args: readonly string[], cwd: string, env = cleanEnv()): Result {
  return spawnSync(process.execPath, [binPath, ...args], { cwd, env, encoding: 'utf8' });
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'vetkit-init-'));
}

// The scaffolded config imports 'vetkit'; a project resolves it from its own node_modules.
function linkVetkit(dir: string): void {
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  symlinkSync(cliPackageDir, join(dir, 'node_modules', 'vetkit'), 'dir');
}

function parseJson(text: string): unknown {
  const result = safeParseJson<unknown>(text, {});
  if (!result.ok) throw result.error;
  return result.value;
}

function read(dir: string, file: string): string {
  return readFileSync(join(dir, file), 'utf8');
}

describe('vet init', () => {
  test('writes the config, criterion, cases and .gitignore into an empty directory', () => {
    const dir = tempDir();
    const result = runVet(['init'], dir);
    expect(result.status).toBe(0);
    for (const file of TARGETS) expect(existsSync(join(dir, file))).toBe(true);
    expect(read(dir, '.gitignore')).toBe('.vet/\n');
  });

  test('--json prints exactly {files:[...]} on stdout', () => {
    const dir = tempDir();
    const result = runVet(['init', '--json'], dir);
    expect(result.status).toBe(0);
    const doc = parseJson(result.stdout);
    // toEqual on the whole document: no key besides files.
    expect(doc).toEqual({ files: expect.arrayContaining([...TARGETS, '.gitignore']) });
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
  });

  test('--dir targets another directory, creating it', () => {
    const cwd = tempDir();
    const result = runVet(['init', '--dir', 'nested/project'], cwd);
    expect(result.status).toBe(0);
    for (const file of TARGETS) expect(existsSync(join(cwd, 'nested/project', file))).toBe(true);
    expect(existsSync(join(cwd, 'vetkit.config.ts'))).toBe(false);
  });

  test('the scaffold loads with the J1 loaders: one boolean criterion with an escape, three cases', async () => {
    const dir = tempDir();
    expect(runVet(['init'], dir).status).toBe(0);
    const criteria = await loadCriteria(join(dir, 'evals/criteria.yaml'));
    expect(criteria.ok).toBe(true);
    if (!criteria.ok) return;
    expect(criteria.criteria).toHaveLength(1);
    expect(criteria.criteria[0]).toMatchObject({ type: 'boolean', escape: expect.any(String) });
    const cases = await loadCases(join(dir, 'evals/cases'));
    expect(cases.ok).toBe(true);
    if (!cases.ok) return;
    expect(cases.cases).toHaveLength(3);
  });

  test('the template criterion passes lint: no ESCAPE_MISSING, no FORBIDDEN_WORD', async () => {
    const criteria = await loadCriteria(templateCriteria);
    expect(criteria.ok).toBe(true);
    if (!criteria.ok) return;
    const ruleIds = lintCriteria(criteria.criteria).map((issue) => issue.ruleId);
    expect(ruleIds).not.toContain('ESCAPE_MISSING');
    expect(ruleIds).not.toContain('FORBIDDEN_WORD');
  });

  test('the criteria template comments explain escape, passWhen and thresholds', () => {
    const comments = readFileSync(templateCriteria, 'utf8')
      .split('\n')
      .filter((line: string) => line.trim().startsWith('#'))
      .join('\n');
    expect(readFileSync(templateCriteria, 'utf8')).toMatch(/^\s+escape:/m);
    expect(comments).toContain('escape');
    expect(comments).toContain('passWhen');
    expect(comments).toContain('threshold');
  });

  test.each(JEV_CREDENTIAL_PRIORITY)(
    'with only the %s credentials set, the config names that preset and never a key value',
    (preset) => {
      const credentials = JEV_PRESETS[preset].credentials;
      const secrets = Object.fromEntries(
        credentials.map((c, i) => [c.name, `secret-${preset}-${String(i)}-9d1c`]),
      );
      const dir = tempDir();
      const result = runVet(['init'], dir, cleanEnv(secrets));
      expect(result.status).toBe(0);
      const config = read(dir, 'vetkit.config.ts');
      expect(config).toContain(`preset: '${preset}'`);
      expect(config).toContain(`apiKeyEnv: '${credentials[0]?.name ?? ''}'`);
      for (const file of [...TARGETS, '.gitignore']) {
        for (const value of Object.values(secrets)) expect(read(dir, file)).not.toContain(value);
      }
      for (const value of Object.values(secrets)) {
        expect(result.stdout).not.toContain(value);
        expect(result.stderr).not.toContain(value);
      }
    },
  );

  test('an existing target file exits 2 CONFIG_INVALID naming it, and writes nothing', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'evals'));
    writeFileSync(join(dir, 'evals/criteria.yaml'), 'mine\n');
    const result = runVet(['init'], dir);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('CONFIG_INVALID');
    expect(result.stderr).toContain('criteria.yaml');
    expect(read(dir, 'evals/criteria.yaml')).toBe('mine\n');
    expect(existsSync(join(dir, 'vetkit.config.ts'))).toBe(false);
    expect(existsSync(join(dir, '.gitignore'))).toBe(false);
  });

  test('--force overwrites existing target files', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'vetkit.config.ts'), 'mine\n');
    const result = runVet(['init', '--force'], dir);
    expect(result.status).toBe(0);
    expect(read(dir, 'vetkit.config.ts')).not.toBe('mine\n');
  });

  test('an existing .gitignore keeps its lines and gains .vet/ once', () => {
    const dir = tempDir();
    writeFileSync(join(dir, '.gitignore'), 'node_modules/');
    expect(runVet(['init'], dir).status).toBe(0);
    expect(read(dir, '.gitignore')).toBe('node_modules/\n.vet/\n');
    expect(runVet(['init', '--force'], dir).status).toBe(0);
    expect(read(dir, '.gitignore')).toBe('node_modules/\n.vet/\n');
  });

  test('an unwritable directory exits 2 naming the path', () => {
    const dir = tempDir();
    chmodSync(dir, 0o500);
    try {
      const result = runVet(['init'], dir);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(dir);
    } finally {
      chmodSync(dir, 0o700);
    }
    expect(readdirSync(dir)).toEqual([]);
  });

  test('`vet run --json` judges the three scaffolded cases (fake judge swapped in)', () => {
    const dir = tempDir();
    expect(runVet(['init'], dir).status).toBe(0);
    copyFileSync(fakeJudgeConfig, join(dir, 'vetkit.config.ts'));
    const result = runVet(['run', '--json'], dir);
    expect(result.status).toBe(0);
    expect(parseJson(result.stdout)).toMatchObject({ summary: { total: 3, aborted: false } });
  });
});

const codeOf = (config: string): string =>
  config
    .split('\n')
    .filter((line: string) => !line.trimStart().startsWith('//'))
    .join('\n');

describe('vet init judge selection', () => {
  const NAMES = ['OPENROUTER_API_KEY', 'AI_GATEWAY_API_KEY', 'TYPESAFE_API_KEY'] as const;
  test('only OPENROUTER_API_KEY: preset openrouter, no allowUnpinned', () => {
    const dir = tempDir();
    const result = runVet(['init'], dir, cleanEnv({ OPENROUTER_API_KEY: 'k' }));
    expect(result.status).toBe(0);
    const config = read(dir, 'vetkit.config.ts');
    expect(config).toContain("preset: 'openrouter'");
    expect(config).toContain("apiKeyEnv: 'OPENROUTER_API_KEY'");
    expect(config).not.toContain('allowUnpinned');
  });

  test('only TYPESAFE_API_KEY: preset typesafe', () => {
    const dir = tempDir();
    expect(runVet(['init'], dir, cleanEnv({ TYPESAFE_API_KEY: 'k' })).status).toBe(0);
    const config = read(dir, 'vetkit.config.ts');
    expect(config).toContain("preset: 'typesafe'");
    expect(config).not.toContain('allowUnpinned');
  });

  test('only AI_GATEWAY_API_KEY: preset vercel, gate.allowUnpinned true, comment mentions pinned', () => {
    const dir = tempDir();
    expect(runVet(['init'], dir, cleanEnv({ AI_GATEWAY_API_KEY: 'k' })).status).toBe(0);
    const config = read(dir, 'vetkit.config.ts');
    expect(config).toContain("preset: 'vercel'");
    expect(codeOf(config)).toMatch(/gate:\s*\{\s*allowUnpinned:\s*true\s*\}/);
    const comments = config
      .split('\n')
      .filter((line: string) => line.trimStart().startsWith('//'))
      .join('\n');
    expect(comments).toContain('pinned');
    expect(comments).toContain('OPENROUTER_API_KEY');
  });

  test('only CLOUDFLARE_API_TOKEN (no account id): treated as no key', () => {
    const dir = tempDir();
    const result = runVet(['init'], dir, cleanEnv({ CLOUDFLARE_API_TOKEN: 'k' }));
    expect(result.status).toBe(0);
    expect(read(dir, 'vetkit.config.ts')).toContain('judge: demoJudge');
  });

  test('AI_GATEWAY_API_KEY and OPENROUTER_API_KEY, no TTY: preset openrouter (first pinned) and an info line naming both', () => {
    const dir = tempDir();
    const result = runVet(
      ['init'],
      dir,
      cleanEnv({ AI_GATEWAY_API_KEY: 'k', OPENROUTER_API_KEY: 'k' }),
    );
    expect(result.status).toBe(0);
    const config = read(dir, 'vetkit.config.ts');
    expect(config).toContain("preset: 'openrouter'");
    expect(config).not.toContain('allowUnpinned');
    expect(result.stderr).toMatch(/^info /m);
    expect(result.stderr).toContain('AI_GATEWAY_API_KEY');
    expect(result.stderr).toContain('OPENROUTER_API_KEY');
  });

  test('with every judge key set and no TTY, the first pinned preset in priority order wins', () => {
    const all = Object.fromEntries(CREDENTIAL_NAMES.map((name) => [name, 'x']));
    const dir = tempDir();
    expect(runVet(['init'], dir, cleanEnv(all)).status).toBe(0);
    expect(read(dir, 'vetkit.config.ts')).toContain("preset: 'openrouter'");
  });

  test('AI_GATEWAY_API_KEY and CLOUDFLARE pair, no TTY: exit 2 NOT_INTERACTIVE naming AI_GATEWAY_API_KEY, CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, nothing written', () => {
    const dir = tempDir();
    const result = runVet(
      ['init'],
      dir,
      cleanEnv({
        AI_GATEWAY_API_KEY: 'k',
        CLOUDFLARE_API_TOKEN: 'k',
        CLOUDFLARE_ACCOUNT_ID: 'a',
      }),
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('NOT_INTERACTIVE');
    for (const name of ['AI_GATEWAY_API_KEY', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']) {
      expect(result.stderr).toContain(name);
    }
    expect(readdirSync(dir)).toEqual([]);
  });

  test('no key: demo judge block, no apiKeyEnv, stderr names the four accepted variables and .env', () => {
    const dir = tempDir();
    const result = runVet(['init'], dir);
    expect(result.status).toBe(0);
    const config = read(dir, 'vetkit.config.ts');
    expect(config).toContain('judge: demoJudge');
    expect(codeOf(config)).not.toMatch(/apiKeyEnv|preset/);
    for (const name of [
      'AI_GATEWAY_API_KEY',
      'OPENROUTER_API_KEY',
      'TYPESAFE_API_KEY',
      'CLOUDFLARE_API_TOKEN',
    ]) {
      expect(result.stderr).toContain(name);
    }
    expect(result.stderr).toContain('.env');
  });

  test('a key present only in <dir>/.env selects the transport (no export)', () => {
    const cwd = tempDir();
    mkdirSync(join(cwd, 'proj'));
    writeFileSync(join(cwd, 'proj/.env'), 'OPENROUTER_API_KEY=from-file-1234\n');
    const result = runVet(['init', '--dir', 'proj'], cwd);
    expect(result.status).toBe(0);
    const config = read(cwd, 'proj/vetkit.config.ts');
    expect(config).toContain("preset: 'openrouter'");
    expect(config).not.toContain('from-file-1234');
    expect(result.stderr).not.toContain('from-file-1234');
  });

  test('--no-env-file ignores <dir>/.env', () => {
    const dir = tempDir();
    writeFileSync(join(dir, '.env'), 'OPENROUTER_API_KEY=from-file-1234\n');
    const result = runVet(['--no-env-file', 'init'], dir);
    expect(result.status).toBe(0);
    expect(read(dir, 'vetkit.config.ts')).toContain('judge: demoJudge');
  });

  test.each([
    ['openrouter', { OPENROUTER_API_KEY: 'k' }, true],
    ['typesafe', { TYPESAFE_API_KEY: 'k' }, true],
    ['vercel', { AI_GATEWAY_API_KEY: 'k' }, false],
  ] as const)(
    'the written config loads with loadVetConfig and the judge capabilities.pinned matches the preset (%s)',
    async (preset, env, pinned) => {
      const dir = tempDir();
      expect(runVet(['init'], dir, cleanEnv(env)).status).toBe(0);
      linkVetkit(dir);
      const loaded = await loadVetConfig({ cwd: dir, env });
      expect(loaded.judge.capabilities.transport).toBe(preset);
      expect(loaded.judge.capabilities.pinned).toBe(pinned);
      expect(JEV_PRESETS[preset].pinned).toBe(pinned);
    },
  );

  test('the config never contains a key value', () => {
    const dir = tempDir();
    const env = Object.fromEntries(NAMES.map((name) => [name, `secret-${name}-7f3a`]));
    expect(runVet(['init'], dir, cleanEnv(env)).status).toBe(0);
    for (const value of Object.values(env))
      expect(read(dir, 'vetkit.config.ts')).not.toContain(value);
  });
});

const templateConfig = readFileSync(join(templatesDir, 'vetkit.config.ts.tmpl'), 'utf8');
const templateCases = readFileSync(join(templatesDir, 'example.jsonl'), 'utf8')
  .split('\n')
  .filter((line: string) => line !== '');

describe('the typed scaffold config', () => {
  test.each(JEV_CREDENTIAL_PRIORITY)(
    'the rendered config imports defineConfig from vetkit and wraps the object in defineConfig() (%s)',
    (preset) => {
      const text = renderConfig(templateConfig, preset);
      const code = text.split('\n').filter((line: string) => !line.startsWith('//'));
      expect(code[0]).toMatch(/^import \{ defineConfig \} from 'vetkit';$/);
      expect(text).toContain('export default defineConfig({');
      expect(text.trimEnd().endsWith('});')).toBe(true);
    },
  );

  test('renderConfig demo: imports demoJudge, sets judge: demoJudge, contains no apiKeyEnv or preset line', () => {
    const text = renderConfig(templateConfig, 'demo');
    expect(text).toContain("import { defineConfig, demoJudge } from 'vetkit';");
    expect(text).toContain('judge: demoJudge,');
    const code = text.split('\n').filter((line: string) => !line.trimStart().startsWith('//'));
    expect(code.join('\n')).not.toMatch(/apiKeyEnv|preset|accountId/);
    expect(text).not.toContain('{{');
  });

  test.each(JEV_CREDENTIAL_PRIORITY)(
    'renderConfig real preset: keeps kind, preset, apiKeyEnv (and accountId for cloudflare) inside defineConfig() (%s)',
    (preset) => {
      const [key, ...rest] = JEV_PRESETS[preset].credentials;
      const text = renderConfig(templateConfig, preset);
      const body = text.slice(text.indexOf('defineConfig({'));
      expect(body).toContain("kind: 'typesafe-compatible'");
      expect(body).toContain(`preset: '${preset}'`);
      expect(body).toContain(`apiKeyEnv: '${key?.name ?? ''}'`);
      for (const c of rest) expect(body).toContain(`accountId: process.env['${c.name}']`);
      if (rest.length === 0) expect(body).not.toContain('accountId');
      expect(text).not.toContain('{{');
    },
  );

  test('a written demo scaffold loads through loadVetConfig with node_modules/vetkit linked to packages/cli: judge.capabilities.transport is demo', async () => {
    const dir = tempDir();
    linkVetkit(dir);
    writeFileSync(join(dir, 'vetkit.config.ts'), renderConfig(templateConfig, 'demo'));
    const loaded = await loadVetConfig({ cwd: dir, env: {} });
    expect(loaded.judge.capabilities.transport).toBe('demo');
  });

  test('a written real-preset scaffold still loads through loadVetConfig with the key env set', async () => {
    const dir = tempDir();
    linkVetkit(dir);
    writeFileSync(join(dir, 'vetkit.config.ts'), renderConfig(templateConfig, 'vercel'));
    const loaded = await loadVetConfig({ cwd: dir, env: { AI_GATEWAY_API_KEY: 'k-test' } });
    expect(loaded.config.judge).toMatchObject({
      preset: 'vercel',
      apiKeyEnv: 'AI_GATEWAY_API_KEY',
    });
    expect(loaded.judge.capabilities.transport).toBe('vercel');
  });

  test('the template comments name .env, vet init --force and the word demo', () => {
    const comments = templateConfig
      .split('\n')
      .filter((line: string) => line.trimStart().startsWith('//'))
      .join('\n');
    expect(comments).toContain('.env');
    expect(comments).toContain('vet init --force');
    expect(comments).toContain('demo');
  });

  test('the template names no vendor', () => {
    expect(templateConfig).not.toMatch(/vercel|typesafe-ai|openrouter|cloudflare/i);
  });
});

describe('the example cases', () => {
  test('the example cases carry no should-fail tag and still number three', () => {
    expect(templateCases).toHaveLength(3);
    expect(templateCases.join('\n')).not.toContain('should-fail');
  });

  test('the template case ids are refund-issued, refund-partial, no-refund-topic', () => {
    const ids = templateCases.map((line) => {
      const doc = parseJson(line);
      return typeof doc === 'object' && doc !== null && 'id' in doc ? doc.id : undefined;
    });
    expect(ids).toEqual(['refund-issued', 'refund-partial', 'no-refund-topic']);
  });

  test('runEvals over the templates with demoJudge exits 0: 3 passed, 0 failed', async () => {
    const result = await runEvals({
      config: {
        criteriaPath: templateCriteria,
        casesDir: templatesDir,
        judge: demoJudge,
        threshold: 0.5,
      },
      lock: null,
    });
    expect(result.exitCode).toBe(0);
    expect(result.summary).toMatchObject({ total: 3, passed: 3, failed: 0 });
  });
});

describe('the published tarball', () => {
  test('bun pm pack lists all three templates', () => {
    const cliDir = fileURLToPath(new URL('../../', import.meta.url));
    const result = spawnSync('bun', ['pm', 'pack', '--dry-run'], { cwd: cliDir, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('templates/criteria.yaml');
    expect(result.stdout).toContain('templates/example.jsonl');
    expect(result.stdout).toContain('templates/vetkit.config.ts.tmpl');
  });
});
