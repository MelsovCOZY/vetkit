import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VetError } from '@vetkit/spec';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { loadVetConfig, projectPaths, resolveConfigFile } from './config-load.ts';
import { judgeRequestCount } from './diag.ts';
import { ensureCliBuilt } from './test-support/build-cli.ts';

const ADAPTER_CONFIG = `export default {
  judge: {
    specVersion: 'v1',
    id: 'inline-judge',
    capabilities: {
      questionTypes: ['boolean', 'choice', 'score'],
      maxStateTokens: 1000,
      pinned: true,
      transport: 'inline',
      model: 'inline-model',
    },
    async doJudge() {
      throw new Error('not called');
    },
  },
  thresholds: { default: 0.7 },
};
`;

function descriptorConfig(judge: Record<string, unknown>): string {
  return `export default { judge: ${JSON.stringify(judge)} };\n`;
}

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'vetkit-config-load-'));
  for (const [name, body] of Object.entries(files)) {
    const target = join(root, name);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, body);
  }
  return root;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected loadVetConfig to reject');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loadVetConfig', () => {
  test('finds vetkit.config.ts in cwd and passes an adapter judge through unchanged', async () => {
    const cwd = await project({ 'vetkit.config.ts': ADAPTER_CONFIG });
    const loaded = await loadVetConfig({ cwd });
    expect(loaded.judge.id).toBe('inline-judge');
    expect(typeof loaded.judge.doJudge).toBe('function');
    expect(loaded.config.thresholds.default).toBe(0.7);
    expect(loaded.configFile).toBe(join(cwd, 'vetkit.config.ts'));
    expect(loaded.rootDir).toBe(cwd);
  });

  test('loads an explicit configPath relative to cwd, rooted at its directory', async () => {
    const cwd = await project({ 'sub/custom.config.ts': ADAPTER_CONFIG });
    const loaded = await loadVetConfig({ cwd, configPath: 'sub/custom.config.ts' });
    expect(loaded.judge.id).toBe('inline-judge');
    expect(loaded.rootDir).toBe(join(cwd, 'sub'));
  });

  test('returns resolveConfig warnings (placeholder threshold)', async () => {
    const cwd = await project({
      'vetkit.config.ts': ADAPTER_CONFIG.replace('thresholds: { default: 0.7 },', ''),
    });
    const loaded = await loadVetConfig({ cwd });
    expect(loaded.warnings.some((w) => w.includes('thresholds.default'))).toBe(true);
  });

  test('builds a Jev judge from a typesafe-compatible preset descriptor, key read from env', async () => {
    const cwd = await project({
      'vetkit.config.ts': descriptorConfig({
        kind: 'typesafe-compatible',
        preset: 'vercel',
        apiKeyEnv: 'FIXTURE_JUDGE_KEY',
      }),
    });
    const loaded = await loadVetConfig({ cwd, env: { FIXTURE_JUDGE_KEY: 'k-123' } });
    expect(loaded.judge.specVersion).toBe('v1');
    expect(loaded.judge.capabilities.transport).toBe('vercel');
    expect(typeof loaded.judge.doJudge).toBe('function');
  });

  test('builds a custom-baseURL Jev judge with the configured model', async () => {
    const cwd = await project({
      'vetkit.config.ts': descriptorConfig({
        kind: 'typesafe-compatible',
        baseURL: 'https://judge.example.test',
        model: 'custom/jev',
        apiKeyEnv: 'FIXTURE_JUDGE_KEY',
      }),
    });
    const loaded = await loadVetConfig({ cwd, env: { FIXTURE_JUDGE_KEY: 'k-123' } });
    expect(loaded.judge.capabilities.model).toBe('custom/jev');
  });

  test('an unset apiKeyEnv is CONFIG_INVALID naming the variable, never a value', async () => {
    const cwd = await project({
      'vetkit.config.ts': descriptorConfig({
        kind: 'typesafe-compatible',
        preset: 'vercel',
        apiKeyEnv: 'FIXTURE_UNSET_KEY',
      }),
    });
    const error = await rejection(loadVetConfig({ cwd, env: {} }));
    expect(VetError.isInstance(error) && error.code).toBe('CONFIG_INVALID');
    expect(error instanceof Error && error.message).toContain('FIXTURE_UNSET_KEY');
  });

  test('requireCredentials:false resolves an unset apiKeyEnv and flags it as missing', async () => {
    const cwd = await project({
      'vetkit.config.ts': descriptorConfig({
        kind: 'typesafe-compatible',
        preset: 'vercel',
        apiKeyEnv: 'FIXTURE_UNSET_KEY',
      }),
    });
    const loaded = await loadVetConfig({ cwd, env: {}, requireCredentials: false });
    expect(loaded.missingCredentials).toEqual(['FIXTURE_UNSET_KEY']);
    expect(loaded.judge.capabilities.transport).toBe('vercel');
    expect(loaded.judge.capabilities.model).toEqual(expect.any(String));
  });

  test('requireCredentials:false with the key set flags nothing missing', async () => {
    const cwd = await project({
      'vetkit.config.ts': descriptorConfig({
        kind: 'typesafe-compatible',
        preset: 'vercel',
        apiKeyEnv: 'FIXTURE_JUDGE_KEY',
      }),
    });
    const loaded = await loadVetConfig({
      cwd,
      env: { FIXTURE_JUDGE_KEY: 'k-123' },
      requireCredentials: false,
    });
    expect(loaded.missingCredentials).toEqual([]);
  });

  test('a judge resolved without its key rejects CONFIG_INVALID and never calls fetch', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const cwd = await project({
      'vetkit.config.ts': descriptorConfig({
        kind: 'typesafe-compatible',
        preset: 'vercel',
        apiKeyEnv: 'FIXTURE_UNSET_KEY',
      }),
    });
    const loaded = await loadVetConfig({ cwd, env: {}, requireCredentials: false });
    const error = await rejection(
      loaded.judge.doJudge({
        state: 's',
        questions: { q: { type: 'boolean', instructions: 'is it?' } },
      }),
    );
    expect(VetError.isInstance(error) && error.code).toBe('CONFIG_INVALID');
    expect(error instanceof Error && error.message).toContain('FIXTURE_UNSET_KEY');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('CEV_JUDGE_BASE_URL overrides the configured baseURL for that process', async () => {
    const fetchSpy = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response('{}', { status: 500 }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const cwd = await project({
      'vetkit.config.ts': descriptorConfig({
        kind: 'typesafe-compatible',
        baseURL: 'https://configured.example.test',
        model: 'custom/jev',
        apiKeyEnv: 'FIXTURE_JUDGE_KEY',
      }),
    });
    const loaded = await loadVetConfig({
      cwd,
      env: { FIXTURE_JUDGE_KEY: 'k-123', CEV_JUDGE_BASE_URL: 'http://127.0.0.1:9' },
    });
    await rejection(
      loaded.judge.doJudge({
        state: 's',
        questions: { q: { type: 'boolean', instructions: 'is it?' } },
      }),
    );
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('http://127.0.0.1:9/v1/systemone');
  });

  test('an unknown descriptor kind is CONFIG_INVALID naming the kind', async () => {
    const cwd = await project({
      'vetkit.config.ts': descriptorConfig({
        kind: 'mystery',
        baseURL: 'https://judge.example.test',
        model: 'm',
        apiKeyEnv: 'FIXTURE_JUDGE_KEY',
      }),
    });
    const error = await rejection(loadVetConfig({ cwd, env: { FIXTURE_JUDGE_KEY: 'k' } }));
    expect(VetError.isInstance(error) && error.code).toBe('CONFIG_INVALID');
    expect(error instanceof Error && error.message).toContain('mystery');
  });

  test('a missing config is CONFIG_INVALID naming the searched paths', async () => {
    const cwd = await project({});
    const error = await rejection(loadVetConfig({ cwd }));
    expect(VetError.isInstance(error) && error.code).toBe('CONFIG_INVALID');
    expect(error instanceof Error && error.message).toContain(join(cwd, 'vetkit.config'));
  });

  test('a missing explicit configPath is CONFIG_INVALID naming that path', async () => {
    const cwd = await project({});
    const error = await rejection(loadVetConfig({ cwd, configPath: 'nope.config.ts' }));
    expect(VetError.isInstance(error) && error.code).toBe('CONFIG_INVALID');
    expect(error instanceof Error && error.message).toContain(join(cwd, 'nope.config.ts'));
  });
});

const ANSWERING_CONFIG = ADAPTER_CONFIG.replace(
  "throw new Error('not called');",
  "return { answers: {}, model: { requested: 'm', resolved: 'm', transport: 'inline', pinned: true } };",
);

const REQUEST = {
  state: 's',
  questions: { q: { type: 'boolean', instructions: 'is it?' } },
} as const;

describe('loadVetConfig requestFormat', () => {
  const endpoint = { kind: 'typesafe-compatible', preset: 'vercel', apiKeyEnv: 'RF_KEY' };

  test.each([
    [{ requestFormat: 'fenced-v1' }, 'fenced-v1'],
    [{ requestFormat: 'raw' }, 'raw'],
    // Default switched to fenced-v1 after the request-format A/B.
    [{}, 'fenced-v1'],
  ])('judge %j yields capabilities.requestFormat %s', async (extra, expected) => {
    vi.stubEnv('RF_KEY', 'k');
    const cwd = await project({
      'vetkit.config.ts': descriptorConfig({ ...endpoint, ...extra }),
    });
    const loaded = await loadVetConfig({ cwd });
    expect(loaded.judge.capabilities.requestFormat).toBe(expected);
  });

  test('an unset key keeps requestFormat on the offline judge', async () => {
    vi.stubEnv('RF_KEY', '');
    const cwd = await project({
      'vetkit.config.ts': descriptorConfig({ ...endpoint, requestFormat: 'fenced-v1' }),
    });
    const loaded = await loadVetConfig({ cwd, requireCredentials: false });
    expect(loaded.judge.capabilities.requestFormat).toBe('fenced-v1');
  });
});

describe('loadVetConfig CEV_DIAG judge counter', () => {
  test('with CEV_DIAG=1 every doJudge call on the loaded judge is counted', async () => {
    const cwd = await project({ 'vetkit.config.ts': ANSWERING_CONFIG });
    const loaded = await loadVetConfig({ cwd, env: { CEV_DIAG: '1' } });
    const before = judgeRequestCount();
    await loaded.judge.doJudge(REQUEST);
    await loaded.judge.doJudge(REQUEST);
    expect(judgeRequestCount() - before).toBe(2);
    expect(loaded.judge.id).toBe('inline-judge');
  });

  test('without CEV_DIAG the judge is not wrapped and nothing is counted', async () => {
    const cwd = await project({ 'vetkit.config.ts': ANSWERING_CONFIG });
    const loaded = await loadVetConfig({ cwd, env: {} });
    const before = judgeRequestCount();
    await loaded.judge.doJudge(REQUEST);
    expect(judgeRequestCount()).toBe(before);
  });
});

describe('config-load vendor neutrality', () => {
  test('config-load.ts names no vendor outside comments', async () => {
    const source = await readFile(new URL('config-load.ts', import.meta.url), 'utf8');
    const code = source.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/\/\/.*$/gm, '');
    expect(code.match(/vercel|openrouter|cloudflare/gi) ?? []).toHaveLength(0);
  });
});

describe('loadVetConfig next-step messages', () => {
  test("no config found: message ends with 'run: vet init'", async () => {
    const cwd = await project({});
    const error = await rejection(loadVetConfig({ cwd, env: {} }));
    expect(VetError.isInstance(error) && error.code).toBe('CONFIG_INVALID');
    expect(error instanceof Error && error.message).toMatch(/run: vet init$/);
  });

  test("missing judge key: message names the var and ends with 'add <VAR>=... to .env or export it'", async () => {
    const cwd = await project({
      'vetkit.config.ts': descriptorConfig({
        kind: 'typesafe-compatible',
        preset: 'openrouter',
        apiKeyEnv: 'OPENROUTER_API_KEY',
      }),
    });
    const error = await rejection(loadVetConfig({ cwd, env: {} }));
    expect(VetError.isInstance(error) && error.code).toBe('CONFIG_INVALID');
    const message = error instanceof Error ? error.message : '';
    expect(message).toContain('OPENROUTER_API_KEY is not set');
    expect(message.endsWith('add OPENROUTER_API_KEY=... to .env or export it')).toBe(true);
  });

  test('missing judge key: the lazy offlineJudge rejection carries the same string', async () => {
    const cwd = await project({
      'vetkit.config.ts': descriptorConfig({
        kind: 'typesafe-compatible',
        preset: 'openrouter',
        apiKeyEnv: 'OPENROUTER_API_KEY',
      }),
    });
    const loaded = await loadVetConfig({ cwd, env: {}, requireCredentials: false });
    const error = await rejection(
      loaded.judge.doJudge({
        state: 's',
        questions: { q: { type: 'boolean', instructions: 'is it?' } },
      }),
    );
    const message = error instanceof Error ? error.message : '';
    expect(message).toContain('OPENROUTER_API_KEY is not set');
    expect(message.endsWith('add OPENROUTER_API_KEY=... to .env or export it')).toBe(true);
  });
});

describe('native config discovery', () => {
  test('finds vetkit.config.ts in a parent directory from a nested cwd', async () => {
    const root = await project({
      'package.json': '{}',
      'vetkit.config.ts': ADAPTER_CONFIG,
      'a/b/.keep': '',
    });
    const loaded = await loadVetConfig({ cwd: join(root, 'a/b') });
    expect(loaded.configFile).toBe(join(root, 'vetkit.config.ts'));
    expect(loaded.rootDir).toBe(root);
  });

  test('stops at the nearest package.json and reports no config with the searched range', async () => {
    const outer = await project({ 'vetkit.config.ts': ADAPTER_CONFIG, 'pkg/package.json': '{}' });
    const cwd = join(outer, 'pkg/src');
    await mkdir(cwd, { recursive: true });
    const error = await rejection(loadVetConfig({ cwd }));
    expect(VetError.isInstance(error) && error.code).toBe('CONFIG_INVALID');
    const message = error instanceof Error ? error.message : '';
    expect(message).toContain(join(cwd, 'vetkit.config'));
    expect(message).toContain(`up to ${join(outer, 'pkg')}`);
    expect(message).not.toContain('.config/vetkit');
  });

  test('prefers .ts over .json in the same directory', async () => {
    const cwd = await project({
      'vetkit.config.ts': ADAPTER_CONFIG,
      'vetkit.config.json': JSON.stringify({ judge: { kind: 'x' } }),
    });
    const loaded = await loadVetConfig({ cwd });
    expect(loaded.configFile).toBe(join(cwd, 'vetkit.config.ts'));
  });

  test('loads vetkit.config.json without a TS loader', async () => {
    const cwd = await project({
      'vetkit.config.json': JSON.stringify({
        judge: { kind: 'typesafe-compatible', preset: 'vercel', apiKeyEnv: 'FIXTURE_JUDGE_KEY' },
      }),
    });
    const loaded = await loadVetConfig({ cwd, env: { FIXTURE_JUDGE_KEY: 'k' } });
    expect(loaded.configFile).toBe(join(cwd, 'vetkit.config.json'));
    expect(loaded.judge.capabilities.transport).toBe('vercel');
  });

  test('an enum in vetkit.config.ts is CONFIG_INVALID naming the Node version and the unsupported syntax', async () => {
    // Under vitest, import() goes through vite (which transpiles enums), so run the built CLI on
    // real Node instead.
    await ensureCliBuilt();
    const cwd = await project({
      'vetkit.config.ts': `enum Kind { A }\nexport default { judge: { kind: Kind.A } };\n`,
    });
    const bin = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
    const result = spawnSync(process.execPath, [bin, 'estimate'], { cwd, encoding: 'utf8' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('CONFIG_INVALID');
    expect(result.stderr).toContain(process.version);
    expect(result.stderr).toContain('enums');
    expect(result.stderr).toContain('unsupported');
  }, 180_000);

  test('paths: dataDir is <root>/evals when it exists, else <root>', async () => {
    const withEvals = await project({ 'vetkit.config.ts': ADAPTER_CONFIG, 'evals/.keep': '' });
    const a = await loadVetConfig({ cwd: withEvals });
    expect(a.paths.rootDir).toBe(withEvals);
    expect(a.paths.dataDir).toBe(join(withEvals, 'evals'));
    expect(a.paths.criteria).toBe(join(withEvals, 'evals', 'criteria.yaml'));
    expect(a.paths.cases).toBe(join(withEvals, 'evals', 'cases'));
    expect(a.paths.lock).toBe(join(withEvals, 'criteria.lock.json'));
    const bare = await project({ 'vetkit.config.ts': ADAPTER_CONFIG });
    const b = await loadVetConfig({ cwd: bare });
    expect(b.paths.dataDir).toBe(bare);
    expect(b.paths.cacheDir).toBe(projectPaths(bare, b.config.cacheDir).cacheDir);
  });

  test('resolveConfigFile returns {configFile, rootDir} without importing the module', async () => {
    const marker = join(tmpdir(), `vetkit-marker-${String(process.pid)}-${String(Date.now())}`);
    const cwd = await project({
      'vetkit.config.ts': `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'x');\n${ADAPTER_CONFIG}`,
    });
    const resolved = resolveConfigFile({ cwd });
    expect(resolved).toEqual({ configFile: join(cwd, 'vetkit.config.ts'), rootDir: cwd });
    expect(existsSync(marker)).toBe(false);
    await loadVetConfig({ cwd, resolved });
    expect(existsSync(marker)).toBe(true);
  });

  test('loadVetConfig({resolved}) imports exactly the resolved file and skips discovery', async () => {
    const cwd = await project({
      'vetkit.config.ts': ADAPTER_CONFIG,
      'other/custom.config.ts': ADAPTER_CONFIG.replace('inline-judge', 'other-judge'),
    });
    const resolved = {
      configFile: join(cwd, 'other/custom.config.ts'),
      rootDir: join(cwd, 'other'),
    };
    const loaded = await loadVetConfig({ cwd, resolved });
    expect(loaded.judge.id).toBe('other-judge');
    expect(loaded.rootDir).toBe(join(cwd, 'other'));
  });

  test('an env var set between resolveConfigFile and loadVetConfig is visible to the config module and to apiKeyEnv resolution', async () => {
    const cwd = await project({
      'vetkit.config.ts': `export default { judge: { kind: 'typesafe-compatible', preset: 'vercel', apiKeyEnv: 'FIXTURE_LATE_KEY', model: process.env.FIXTURE_LATE_MODEL ?? 'unset' } };\n`,
    });
    const env: Record<string, string | undefined> = {};
    const resolved = resolveConfigFile({ cwd });
    env.FIXTURE_LATE_KEY = 'late-key';
    vi.stubEnv('FIXTURE_LATE_MODEL', 'late-model');
    const loaded = await loadVetConfig({ cwd, env, resolved });
    expect(loaded.missingCredentials).toEqual([]);
    expect(loaded.judge.capabilities.model).toBe('late-model');
  });
});
