import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintCriteria, loadCases, loadCriteria } from '@vetkit/core';
import { JEV_CREDENTIAL_PRIORITY, JEV_PRESETS } from '@vetkit/judge-jev';
import { safeParseJson } from '@vetkit/spec';
import { beforeAll, describe, expect, test } from 'vitest';
import { loadVetConfig } from '../config-load.ts';
import { ensureCliBuilt } from '../test-support/build-cli.js';

const binPath = fileURLToPath(new URL('../../dist/bin.js', import.meta.url));
const fakeJudgeConfig = fileURLToPath(
  new URL('../../../../fixtures/cli/run/vetkit.config.ts', import.meta.url),
);
const templateCriteria = fileURLToPath(new URL('../../templates/criteria.yaml', import.meta.url));

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
      .filter((line) => line.trim().startsWith('#'))
      .join('\n');
    expect(readFileSync(templateCriteria, 'utf8')).toMatch(/^\s+escape:/m);
    expect(comments).toContain('escape');
    expect(comments).toContain('passWhen');
    expect(comments).toContain('threshold');
  });

  test('with no judge key set: the default preset, its key env var, and a stderr hint naming all of them', async () => {
    const dir = tempDir();
    const result = runVet(['init'], dir);
    expect(result.status).toBe(0);
    for (const name of CREDENTIAL_NAMES) expect(result.stderr).toContain(name);
    const [preset] = JEV_CREDENTIAL_PRIORITY;
    expect(preset).toBe('vercel');
    const apiKeyEnv = 'AI_GATEWAY_API_KEY';
    const loaded = await loadVetConfig({ cwd: dir, env: { [apiKeyEnv]: 'k-test' } });
    expect(loaded.config.judge).toMatchObject({ preset, apiKeyEnv });
    expect(loaded.judge.capabilities.transport).toBe(preset);
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

  test('with every judge key set, the first preset in priority order wins and an info line names them', () => {
    const all = Object.fromEntries(CREDENTIAL_NAMES.map((name) => [name, 'x']));
    const dir = tempDir();
    const result = runVet(['init'], dir, cleanEnv(all));
    expect(result.status).toBe(0);
    const [first, second] = JEV_CREDENTIAL_PRIORITY;
    expect(read(dir, 'vetkit.config.ts')).toContain(`preset: '${first ?? ''}'`);
    expect(result.stderr).toMatch(/^info /m);
    expect(result.stderr).toContain(first);
    expect(result.stderr).toContain(second);
  });

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
