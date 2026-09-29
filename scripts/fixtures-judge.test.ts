import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const CONFIGS = [
  'fixtures/gauntlet-fail',
  'fixtures/projects/j2',
  'fixtures/projects/j3',
  'fixtures/projects/j4',
  'fixtures/projects/j6',
  'fixtures/projects/j7',
];

interface Judge {
  kind: string;
  preset: string;
  apiKeyEnv: string;
  providerOptions?: unknown;
}
interface Generator {
  baseURL: string;
  apiKeyEnv: string;
}
interface Loaded {
  judge: Judge;
  generator?: Generator;
}

async function load(dir: string, judge: string | undefined): Promise<Loaded> {
  vi.resetModules();
  vi.unstubAllEnvs();
  if (judge !== undefined) vi.stubEnv('CEV_SMOKE_JUDGE', judge);
  const mod: { default: Loaded } = await import(join(ROOT, dir, 'vetkit.config.ts'));
  return mod.default;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe.each(CONFIGS)('%s vetkit.config.ts', (dir) => {
  test('defaults to the vercel preset with the gateway key and provider options', async () => {
    const { judge } = await load(dir, undefined);
    expect(judge.preset).toBe('vercel');
    expect(judge.apiKeyEnv).toBe('AI_GATEWAY_API_KEY');
    expect(judge.providerOptions).toEqual({
      gateway: { zeroDataRetention: true, only: ['typesafe-ai'] },
    });
  });

  test('CEV_SMOKE_JUDGE=vercel resolves the vercel preset', async () => {
    const { judge } = await load(dir, 'vercel');
    expect(judge.preset).toBe('vercel');
    expect(judge.apiKeyEnv).toBe('AI_GATEWAY_API_KEY');
  });

  test('CEV_SMOKE_JUDGE=openrouter resolves the openrouter preset without gateway options', async () => {
    const { judge } = await load(dir, 'openrouter');
    expect(judge.kind).toBe('typesafe-compatible');
    expect(judge.preset).toBe('openrouter');
    expect(judge.apiKeyEnv).toBe('OPENROUTER_API_KEY');
    expect(judge.providerOptions).toBeUndefined();
  });

  test('an unknown CEV_SMOKE_JUDGE fails fast naming the variable', async () => {
    await expect(load(dir, 'bogus')).rejects.toThrow(/CEV_SMOKE_JUDGE/);
  });
});

describe('generator independence', () => {
  test('j3 generator keeps the gateway endpoint whichever judge is selected', async () => {
    const vercel = await load('fixtures/projects/j3', 'vercel');
    const openrouter = await load('fixtures/projects/j3', 'openrouter');
    expect(openrouter.generator).toEqual(vercel.generator);
    expect(openrouter.generator?.baseURL).toBe('https://ai-gateway.vercel.sh/v1');
    expect(openrouter.generator?.apiKeyEnv).toBe('AI_GATEWAY_API_KEY');
  });

  test('j2 generator does not change with the judge', async () => {
    const vercel = await load('fixtures/projects/j2', 'vercel');
    const openrouter = await load('fixtures/projects/j2', 'openrouter');
    expect(openrouter.generator).toEqual(vercel.generator);
  });
});

describe('scripts/smoke-j1.sh', () => {
  test('an unknown CEV_SMOKE_JUDGE exits non-zero naming the variable, before any build', () => {
    const run = spawnSync('bash', [join(ROOT, 'scripts/smoke-j1.sh')], {
      encoding: 'utf8',
      env: { ...process.env, CEV_SMOKE_JUDGE: 'bogus', AI_GATEWAY_API_KEY: 'x' },
      timeout: 20_000,
    });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('CEV_SMOKE_JUDGE');
    expect(run.stdout).not.toContain('building');
  });
});
