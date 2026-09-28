import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VetError } from '@vetkit/spec';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { loadVetConfig } from './config-load.ts';
import { judgeRequestCount } from './diag.ts';

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

describe('loadVetConfig CEV_DIAG judge counter (mol-0nw.24)', () => {
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
