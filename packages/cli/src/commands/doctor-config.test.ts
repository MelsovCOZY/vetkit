// `vet doctor --config`: the resolved vetkit config, with every *Env value shown only as
// <set>/<unset>.
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safeParseJson } from '@vetkit/spec';
import { Command } from 'commander';
import { describe, expect, test, vi } from 'vitest';
import { registerDoctor } from './doctor.ts';

const SECRET = 'sk-doctor-config-secret-4242';
const GEN_SECRET = 'sk-doctor-generator-secret-5151';

function parseJson(text: string): unknown {
  const result = safeParseJson<unknown>(text, {});
  if (!result.ok) throw result.error;
  return result.value;
}

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'vetkit-doctor-config-'));
  for (const [name, body] of Object.entries(files)) {
    const target = join(root, name);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, body);
  }
  return root;
}

const DESCRIPTOR_CONFIG = `export default {
  judge: { kind: 'typesafe-compatible', preset: 'vercel', apiKeyEnv: 'DOCTOR_JUDGE_KEY' },
  generator: {
    kind: 'openai-compatible',
    baseURL: 'https://generator.example.test/v1',
    apiKeyEnv: 'DOCTOR_GEN_KEY',
    model: 'gen-model',
  },
  thresholds: { default: 0.7 },
};
`;

// An adapter judge holding a secret on a property: doctor must print only its identity.
const ADAPTER_CONFIG = `export default {
  judge: {
    specVersion: 'v1',
    id: 'inline-judge',
    apiKey: '${SECRET}',
    capabilities: {
      questionTypes: ['boolean'],
      maxStateTokens: 1000,
      pinned: true,
      transport: 'inline',
      model: 'inline-model',
    },
    async doJudge() {
      throw new Error('not called');
    },
  },
};
`;

interface Run {
  readonly stdout: string;
  readonly exitCode: number | undefined;
}

async function doctor(
  args: readonly string[],
  cwd: string,
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch = vi.fn(async () => new Response('{}', { status: 200 })),
): Promise<Run> {
  const program = new Command().option('--json');
  program.exitOverride();
  const chunks: string[] = [];
  let exitCode: number | undefined;
  registerDoctor(program, {
    nodeVersion: 'v22.23.2',
    bunPresent: () => true,
    lefthookInstalled: () => true,
    cwd,
    env,
    fetchImpl,
    stdout: { write: (chunk: string) => chunks.push(chunk) },
    setExitCode: (code) => {
      exitCode = code;
    },
  });
  await program.parseAsync(['doctor', ...args], { from: 'user' });
  return { stdout: chunks.join(''), exitCode };
}

function configOf(doc: unknown): unknown {
  if (typeof doc !== 'object' || doc === null || !('config' in doc)) {
    throw new Error('doctor --json output has no config field');
  }
  return doc.config;
}

describe('vet doctor --config --json', () => {
  test('prints the resolved config with a set *Env value as <set>, never the secret', async () => {
    const cwd = await project({ 'vetkit.config.ts': DESCRIPTOR_CONFIG });
    const run = await doctor(['--config', '--json'], cwd, {
      DOCTOR_JUDGE_KEY: SECRET,
      DOCTOR_GEN_KEY: GEN_SECRET,
    });
    expect(run.stdout).not.toContain(SECRET);
    expect(run.stdout).not.toContain(GEN_SECRET);
    const config = configOf(parseJson(run.stdout));
    expect(config).toMatchObject({
      file: join(cwd, 'vetkit.config.ts'),
      resolved: {
        judge: { kind: 'typesafe-compatible', preset: 'vercel', apiKeyEnv: '<set>' },
        generator: { kind: 'openai-compatible', model: 'gen-model', apiKeyEnv: '<set>' },
        thresholds: { default: 0.7 },
        cacheDir: '.vet',
        gate: { requireCalibrated: true, allowUnpinned: false },
      },
    });
  });

  test('an unset *Env value is <unset>, and the config still resolves', async () => {
    const cwd = await project({ 'vetkit.config.ts': DESCRIPTOR_CONFIG });
    const run = await doctor(['--config', '--json'], cwd, { DOCTOR_GEN_KEY: GEN_SECRET });
    expect(run.stdout).not.toContain(GEN_SECRET);
    expect(configOf(parseJson(run.stdout))).toMatchObject({
      resolved: { judge: { apiKeyEnv: '<unset>' }, generator: { apiKeyEnv: '<set>' } },
    });
  });

  test('never prints the variable names behind *Env values in the JSON config', async () => {
    const cwd = await project({ 'vetkit.config.ts': DESCRIPTOR_CONFIG });
    const run = await doctor(['--config', '--json'], cwd, { DOCTOR_JUDGE_KEY: SECRET });
    expect(JSON.stringify(configOf(parseJson(run.stdout)))).not.toContain('DOCTOR_JUDGE_KEY');
  });

  test('an adapter judge is shown by identity only; its own properties never print', async () => {
    const cwd = await project({ 'vetkit.config.ts': ADAPTER_CONFIG });
    const run = await doctor(['--config', '--json'], cwd, {});
    expect(run.stdout).not.toContain(SECRET);
    expect(configOf(parseJson(run.stdout))).toMatchObject({
      resolved: {
        judge: { specVersion: 'v1', id: 'inline-judge', capabilities: { model: 'inline-model' } },
      },
    });
  });

  test('includes the placeholder-threshold warning from resolveConfig', async () => {
    const cwd = await project({ 'vetkit.config.ts': ADAPTER_CONFIG });
    const run = await doctor(['--config', '--json'], cwd, {});
    const config = configOf(parseJson(run.stdout));
    expect(config).toMatchObject({ warnings: [expect.stringContaining('thresholds.default')] });
  });

  test('--config <path> loads that file instead of discovering one', async () => {
    const cwd = await project({ 'nested/custom.config.ts': ADAPTER_CONFIG });
    const run = await doctor(['--config', 'nested/custom.config.ts', '--json'], cwd, {});
    expect(configOf(parseJson(run.stdout))).toMatchObject({
      file: join(cwd, 'nested', 'custom.config.ts'),
      resolved: { judge: { id: 'inline-judge' } },
    });
  });

  test('without --config the JSON carries no config field', async () => {
    const cwd = await project({ 'vetkit.config.ts': DESCRIPTOR_CONFIG });
    const run = await doctor(['--json'], cwd, { DOCTOR_JUDGE_KEY: SECRET });
    const doc = parseJson(run.stdout);
    expect(typeof doc === 'object' && doc !== null && 'config' in doc).toBe(false);
  });

  test('a config that fails to load is a fail row and exit code 1, with no config field', async () => {
    const cwd = await project({ 'vetkit.config.ts': 'export default { judge: 42 };\n' });
    const run = await doctor(['--config', '--json'], cwd, {});
    const doc = parseJson(run.stdout);
    expect(doc).toMatchObject({
      checks: expect.arrayContaining([expect.objectContaining({ name: 'config', status: 'fail' })]),
    });
    expect(typeof doc === 'object' && doc !== null && 'config' in doc).toBe(false);
    expect(run.exitCode).toBe(1);
  });
});

describe('vet doctor --config judge health probe', () => {
  test('a cloudflare descriptor probes the accountId from the config, not the env', async () => {
    const cwd = await project({
      'vetkit.config.ts': `export default {
  judge: {
    kind: 'typesafe-compatible',
    preset: 'cloudflare',
    accountId: 'acct-from-config',
    apiKeyEnv: 'DOCTOR_CF_KEY',
  },
};
`,
    });
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      urls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      return new Response(null, { status: 200 });
    });
    await doctor(['--config', '--json'], cwd, { DOCTOR_CF_KEY: SECRET }, fetchImpl);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('/accounts/acct-from-config/');
  });
});

describe('vet doctor --config (text)', () => {
  test('appends the describeConfig lines after the check table, naming env vars only', async () => {
    const cwd = await project({ 'vetkit.config.ts': DESCRIPTOR_CONFIG });
    const run = await doctor(['--config'], cwd, {
      DOCTOR_JUDGE_KEY: SECRET,
      DOCTOR_GEN_KEY: GEN_SECRET,
    });
    expect(run.stdout).not.toContain(SECRET);
    expect(run.stdout).not.toContain(GEN_SECRET);
    expect(run.stdout).toContain(`config ${join(cwd, 'vetkit.config.ts')}`);
    expect(run.stdout).toContain('  judge: typesafe-compatible preset vercel');
    expect(run.stdout).toContain('(key from $DOCTOR_JUDGE_KEY)');
    expect(run.stdout).toContain('  cacheDir: .vet');
  });
});
