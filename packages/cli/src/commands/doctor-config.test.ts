// `vet doctor --config`: the resolved vetkit config, with every *Env value shown only as
// <set>/<unset>.
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JEV_PRESETS } from '@vetkit/judge-jev';
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

const SINK_CONFIG = `export default {
  judge: { kind: 'typesafe-compatible', preset: 'vercel', apiKeyEnv: 'DOCTOR_JUDGE_KEY' },
  sinks: [{ kind: 'otel', endpoint: 'https://otel.example.test', headersEnv: 'DOCTOR_OTEL_HEADERS' }],
  thresholds: { default: 0.7 },
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
    const run = await doctor(['--config', 'vetkit.config.ts', '--json'], cwd, {
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
    const run = await doctor(['--config', 'vetkit.config.ts', '--json'], cwd, {
      DOCTOR_GEN_KEY: GEN_SECRET,
    });
    expect(run.stdout).not.toContain(GEN_SECRET);
    expect(configOf(parseJson(run.stdout))).toMatchObject({
      resolved: { judge: { apiKeyEnv: '<unset>' }, generator: { apiKeyEnv: '<set>' } },
    });
  });

  test('never prints the variable names behind *Env values in the JSON config', async () => {
    const cwd = await project({ 'vetkit.config.ts': DESCRIPTOR_CONFIG });
    const run = await doctor(['--config', 'vetkit.config.ts', '--json'], cwd, {
      DOCTOR_JUDGE_KEY: SECRET,
    });
    expect(JSON.stringify(configOf(parseJson(run.stdout)))).not.toContain('DOCTOR_JUDGE_KEY');
  });

  test('an adapter judge is shown by identity only; its own properties never print', async () => {
    const cwd = await project({ 'vetkit.config.ts': ADAPTER_CONFIG });
    const run = await doctor(['--config', 'vetkit.config.ts', '--json'], cwd, {});
    expect(run.stdout).not.toContain(SECRET);
    expect(configOf(parseJson(run.stdout))).toMatchObject({
      resolved: {
        judge: { specVersion: 'v1', id: 'inline-judge', capabilities: { model: 'inline-model' } },
      },
    });
  });

  test('includes the placeholder-threshold warning from resolveConfig', async () => {
    const cwd = await project({ 'vetkit.config.ts': ADAPTER_CONFIG });
    const run = await doctor(['--config', 'vetkit.config.ts', '--json'], cwd, {});
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
    const run = await doctor(['--config', 'vetkit.config.ts', '--json'], cwd, {});
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
    await doctor(
      ['--config', 'vetkit.config.ts', '--json'],
      cwd,
      { DOCTOR_CF_KEY: SECRET },
      fetchImpl,
    );
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('/accounts/acct-from-config/');
  });
});

describe('vet doctor --config (text)', () => {
  test('appends the describeConfig lines after the check table, naming env vars only', async () => {
    const cwd = await project({ 'vetkit.config.ts': DESCRIPTOR_CONFIG });
    const run = await doctor(['--config', 'vetkit.config.ts'], cwd, {
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

function sinkRow(stdout: string): unknown {
  const doc = parseJson(stdout);
  if (typeof doc !== 'object' || doc === null || !('checks' in doc) || !Array.isArray(doc.checks)) {
    throw new Error('doctor --json output has no checks');
  }
  return doc.checks.find(
    (c: unknown) =>
      typeof c === 'object' && c !== null && 'name' in c && c.name === 'sink credentials',
  );
}

describe('vet doctor sink descriptor credentials', () => {
  test('--json carries the warn row naming the unset variable; the exit code stays 0', async () => {
    const cwd = await project({ 'vetkit.config.ts': SINK_CONFIG });
    const run = await doctor(['--config', 'vetkit.config.ts', '--json'], cwd, {
      DOCTOR_JUDGE_KEY: SECRET,
    });
    expect(sinkRow(run.stdout)).toMatchObject({
      status: 'warn',
      detail: expect.stringContaining('DOCTOR_OTEL_HEADERS=<unset>'),
    });
    expect(run.exitCode).toBe(0);
  });

  test('--json carries the pass row when the variable is set, without printing its value', async () => {
    const cwd = await project({ 'vetkit.config.ts': SINK_CONFIG });
    const run = await doctor(['--config', 'vetkit.config.ts', '--json'], cwd, {
      DOCTOR_JUDGE_KEY: SECRET,
      DOCTOR_OTEL_HEADERS: GEN_SECRET,
    });
    expect(sinkRow(run.stdout)).toMatchObject({
      status: 'pass',
      detail: expect.stringContaining('DOCTOR_OTEL_HEADERS=<set>'),
    });
    expect(run.stdout).not.toContain(GEN_SECRET);
    expect(run.exitCode).toBe(0);
  });
});

function urlOf(input: string | URL | Request): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

function recordingFetch(urls: string[], headers: unknown[] = []): typeof fetch {
  return vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    urls.push(urlOf(input));
    headers.push(init?.headers);
    return new Response('{}', { status: 200 });
  });
}

function judgeConfig(fields: string): string {
  return `export default { judge: { kind: 'typesafe-compatible', apiKeyEnv: 'DOCTOR_JUDGE_KEY', ${fields} } };\n`;
}

describe('vet doctor health probe URL', () => {
  test('health probes the configured baseURL with the preset path, not the preset host', async () => {
    const cwd = await project({
      'vetkit.config.ts': judgeConfig(
        `preset: 'openrouter', baseURL: 'https://proxy.example.test'`,
      ),
    });
    const urls: string[] = [];
    await doctor(['--json'], cwd, { DOCTOR_JUDGE_KEY: SECRET }, recordingFetch(urls));
    expect(urls).toEqual(['https://proxy.example.test/v1/models?output_modalities=all']);
  });

  test('a trailing slash on the baseURL does not double the slash', async () => {
    const cwd = await project({
      'vetkit.config.ts': judgeConfig(`preset: 'typesafe', baseURL: 'https://proxy.example.test/'`),
    });
    const urls: string[] = [];
    await doctor(['--json'], cwd, { DOCTOR_JUDGE_KEY: SECRET }, recordingFetch(urls));
    expect(urls).toEqual(['https://proxy.example.test/v1/models']);
  });

  test('CEV_JUDGE_BASE_URL redirects the doctor probe', async () => {
    const cwd = await project({ 'vetkit.config.ts': judgeConfig(`preset: 'typesafe'`) });
    const urls: string[] = [];
    await doctor(
      ['--json'],
      cwd,
      { DOCTOR_JUDGE_KEY: SECRET, CEV_JUDGE_BASE_URL: 'https://override.example.test' },
      recordingFetch(urls),
    );
    expect(urls).toEqual(['https://override.example.test/v1/models']);
  });

  test('a custom endpoint probes <baseURL>/v1/models with the configured key', async () => {
    const cwd = await project({
      'vetkit.config.ts': judgeConfig(
        `baseURL: 'https://custom.example.test/api', model: 'custom-model'`,
      ),
    });
    const urls: string[] = [];
    const headers: unknown[] = [];
    const run = await doctor(
      ['--json'],
      cwd,
      { DOCTOR_JUDGE_KEY: SECRET },
      recordingFetch(urls, headers),
    );
    expect(urls).toEqual(['https://custom.example.test/api/v1/models']);
    expect(headers).toEqual([{ Authorization: `Bearer ${SECRET}` }]);
    expect(run.stdout).not.toContain('no health probe');
    expect(run.stdout).not.toContain(SECRET);
  });
});

interface ValueRow {
  readonly name: string;
  readonly value: string;
  readonly source: string;
}

function isValueRow(row: unknown): row is ValueRow {
  return (
    typeof row === 'object' &&
    row !== null &&
    'name' in row &&
    typeof row.name === 'string' &&
    'value' in row &&
    typeof row.value === 'string' &&
    'source' in row &&
    typeof row.source === 'string'
  );
}

function valuesOf(stdout: string): ValueRow[] {
  const doc = parseJson(stdout);
  if (typeof doc !== 'object' || doc === null || !('values' in doc) || !Array.isArray(doc.values)) {
    throw new Error('doctor --json output has no values');
  }
  return doc.values.filter(isValueRow);
}

function valueRow(stdout: string, name: string): { value: string; source: string } | undefined {
  return valuesOf(stdout).find((v) => v.name === name);
}

const CANARY = 'sk-doctor-values-canary-7777';
const PACKAGE = { 'package.json': '{}' };

describe('vet doctor names the layer behind each resolved value', () => {
  test('doctor without --config resolves a discovered vetkit.config.ts (config row says loaded, values present)', async () => {
    const cwd = await project({ ...PACKAGE, 'vetkit.config.ts': DESCRIPTOR_CONFIG });
    const run = await doctor(['--json'], cwd, { DOCTOR_JUDGE_KEY: CANARY });
    const doc = parseJson(run.stdout);
    expect(doc).toMatchObject({
      checks: expect.arrayContaining([
        expect.objectContaining({
          name: 'config',
          status: 'pass',
          detail: expect.stringContaining('loaded'),
        }),
      ]),
    });
    expect(valueRow(run.stdout, 'transport')).toEqual({
      name: 'transport',
      value: 'vercel',
      source: 'config',
    });
    expect(valueRow(run.stdout, 'key var')).toMatchObject({
      value: 'DOCTOR_JUDGE_KEY',
      source: 'config',
    });
    expect(valueRow(run.stdout, 'config file')).toMatchObject({
      value: join(cwd, 'vetkit.config.ts'),
      source: 'config',
    });
  });

  test('key value source is .env when the key came from the env file', async () => {
    const cwd = await project({
      ...PACKAGE,
      'vetkit.config.ts': DESCRIPTOR_CONFIG,
      '.env': `DOCTOR_JUDGE_KEY=${CANARY}\n`,
    });
    const run = await doctor(['--json'], cwd, {});
    expect(valueRow(run.stdout, 'key value')).toMatchObject({ value: '<set>', source: '.env' });
  });

  test('key value source is env when process env supplied it even though .env also defines it', async () => {
    const cwd = await project({
      ...PACKAGE,
      'vetkit.config.ts': DESCRIPTOR_CONFIG,
      '.env': `DOCTOR_JUDGE_KEY=${CANARY}\n`,
    });
    const run = await doctor(['--json'], cwd, { DOCTOR_JUDGE_KEY: 'from-shell' });
    expect(valueRow(run.stdout, 'key value')).toMatchObject({ value: '<set>', source: 'env' });
  });

  test('key value is <unset> from default when nothing supplies it', async () => {
    const cwd = await project({ ...PACKAGE, 'vetkit.config.ts': DESCRIPTOR_CONFIG });
    const run = await doctor(['--json'], cwd, {});
    expect(valueRow(run.stdout, 'key value')).toMatchObject({
      value: '<unset>',
      source: 'default',
    });
  });

  test('baseURL source is env under CEV_JUDGE_BASE_URL, config when the descriptor sets it, default otherwise', async () => {
    const plain = await project({
      ...PACKAGE,
      'vetkit.config.ts': judgeConfig(`preset: 'typesafe'`),
    });
    const dflt = await doctor(['--json'], plain, { DOCTOR_JUDGE_KEY: 'k' });
    expect(valueRow(dflt.stdout, 'baseURL')).toMatchObject({
      value: JEV_PRESETS.typesafe.baseURL,
      source: 'default',
    });
    const overridden = await doctor(['--json'], plain, {
      DOCTOR_JUDGE_KEY: 'k',
      CEV_JUDGE_BASE_URL: 'https://override.example.test',
    });
    expect(valueRow(overridden.stdout, 'baseURL')).toMatchObject({
      value: 'https://override.example.test',
      source: 'env',
    });
    const set = await project({
      ...PACKAGE,
      'vetkit.config.ts': judgeConfig(`preset: 'typesafe', baseURL: 'https://cfg.example.test'`),
    });
    const configured = await doctor(['--json'], set, { DOCTOR_JUDGE_KEY: 'k' });
    expect(valueRow(configured.stdout, 'baseURL')).toMatchObject({
      value: 'https://cfg.example.test',
      source: 'config',
    });
  });

  test('model source is default for a preset without model, config when set', async () => {
    const plain = await project({
      ...PACKAGE,
      'vetkit.config.ts': judgeConfig(`preset: 'vercel'`),
    });
    const dflt = await doctor(['--json'], plain, {});
    expect(valueRow(dflt.stdout, 'model')).toMatchObject({
      value: JEV_PRESETS.vercel.defaultModel,
      source: 'default',
    });
    const set = await project({
      ...PACKAGE,
      'vetkit.config.ts': judgeConfig(`preset: 'vercel', model: 'my-model'`),
    });
    const configured = await doctor(['--json'], set, {});
    expect(valueRow(configured.stdout, 'model')).toMatchObject({
      value: 'my-model',
      source: 'config',
    });
  });

  test('config file source is flag with --config <path>', async () => {
    const cwd = await project({ 'nested/custom.config.ts': DESCRIPTOR_CONFIG });
    const run = await doctor(['--config', 'nested/custom.config.ts', '--json'], cwd, {});
    expect(valueRow(run.stdout, 'config file')).toEqual({
      name: 'config file',
      value: join(cwd, 'nested', 'custom.config.ts'),
      source: 'flag',
    });
  });

  test('an adapter judge yields only config file and transport rows', async () => {
    const cwd = await project({ ...PACKAGE, 'vetkit.config.ts': ADAPTER_CONFIG });
    const run = await doctor(['--json'], cwd, {});
    expect(valuesOf(run.stdout).map((v) => v.name)).toEqual(['config file', 'transport']);
  });

  test('values never carry a key value: --json output does not contain the canary', async () => {
    const cwd = await project({
      ...PACKAGE,
      'vetkit.config.ts': DESCRIPTOR_CONFIG,
      '.env': `DOCTOR_JUDGE_KEY=${CANARY}\n`,
    });
    for (const args of [['--json'], []]) {
      const run = await doctor(args, cwd, {});
      expect(run.stdout).not.toContain(CANARY);
    }
    const shell = await doctor(['--json'], cwd, { DOCTOR_JUDGE_KEY: CANARY });
    expect(shell.stdout).not.toContain(CANARY);
  });

  test('text output appends a values block after the check table', async () => {
    const cwd = await project({
      ...PACKAGE,
      'vetkit.config.ts': DESCRIPTOR_CONFIG,
      '.env': `DOCTOR_JUDGE_KEY=${CANARY}\n`,
    });
    const run = await doctor([], cwd, {});
    expect(run.stdout).toMatch(/^values$/m);
    expect(run.stdout).toContain('  key value    <set> (.env)');
    expect(run.stdout.indexOf('judge endpoint health')).toBeLessThan(
      run.stdout.search(/^values$/m),
    );
  });

  test('no config found: no values section, sniff table shown, config row fail', async () => {
    const cwd = await project({ ...PACKAGE });
    const run = await doctor(['--json'], cwd, { AI_GATEWAY_API_KEY: CANARY });
    const doc = parseJson(run.stdout);
    expect(typeof doc === 'object' && doc !== null && 'values' in doc).toBe(false);
    expect(doc).toMatchObject({
      checks: expect.arrayContaining([
        expect.objectContaining({ name: 'config', status: 'fail' }),
        expect.objectContaining({ name: 'judge credential' }),
      ]),
    });
    const text = await doctor([], cwd, { AI_GATEWAY_API_KEY: CANARY });
    expect(text.stdout).not.toMatch(/^values$/m);
  });
});
