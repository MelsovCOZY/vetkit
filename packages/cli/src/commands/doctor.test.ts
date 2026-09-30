import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JEV_PRESETS } from '@vetkit/judge-jev';
import { safeParseJson } from '@vetkit/spec';
import { Command } from 'commander';
import { describe, expect, test, vi } from 'vitest';
import { ENV_VARS, registerDoctor, renderJson, renderTable, runDoctor } from './doctor.ts';

// safeParseJson(text, schema) is the one JSON.parse chokepoint under packages/*/src
// (packages/spec/src/json.ts); `{}` is the permissive "any JSON value" schema.
function parseJson(text: string): unknown {
  const result = safeParseJson<unknown>(text, {});
  if (!result.ok) throw result.error;
  return result.value;
}

// A project whose config selects the typesafe preset with TYPESAFE_API_KEY: doctor resolves
// it by default, so the tests that only need a healthy config share this directory.
const PROJECT_DIR = mkdtempSync(join(tmpdir(), 'vetkit-doctor-pass-'));
writeFileSync(join(PROJECT_DIR, 'package.json'), '{}');
writeFileSync(
  join(PROJECT_DIR, 'vetkit.config.ts'),
  `export default { judge: { kind: 'typesafe-compatible', preset: 'typesafe', apiKeyEnv: 'TYPESAFE_API_KEY' } };\n`,
);

const PASSING_DEPS = { nodeVersion: 'v22.23.2', cwd: PROJECT_DIR };

// No config found: the sniff table (env-var priority list) is shown.
const SNIFF_DEPS = { nodeVersion: 'v22.23.2', configExists: () => false };

function statusOf(
  checks: readonly { name: string; status: string; detail: string }[],
  name: string,
) {
  const found = checks.find((c) => c.name === name);
  if (!found) throw new Error(`no check named "${name}"`);
  return found;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('runDoctor', () => {
  test('all set: every check passes and exit code is 0', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { name: 'jev-1.13.0', release_date: '2026-09-15' }),
    );
    const result = await runDoctor({
      ...PASSING_DEPS,
      env: { TYPESAFE_API_KEY: 'fake-typesafe-key' },
      fetchImpl,
    });
    expect(result.exitCode).toBe(0);
    expect(result.checks.some((c) => c.status === 'fail')).toBe(false);
    expect(statusOf(result.checks, 'judge credential').status).toBe('pass');
    expect(statusOf(result.checks, 'judge endpoint health').status).toBe('pass');
  });

  test('no judge key: judge credential is a fail row naming the four accepted variables', async () => {
    const result = await runDoctor({
      ...SNIFF_DEPS,
      env: {},
      fetchImpl: vi.fn(),
    });
    const row = statusOf(result.checks, 'judge credential');
    expect(row.status).toBe('fail');
    expect(row.detail).toContain('AI_GATEWAY_API_KEY');
    expect(row.detail).toContain('OPENROUTER_API_KEY');
    expect(row.detail).toContain('CLOUDFLARE_API_TOKEN');
    expect(row.detail).toContain('TYPESAFE_API_KEY');
    expect(result.exitCode).toBe(1);
  });

  test('multiple judge keys set: info row names the config-selected transport', async () => {
    const result = await runDoctor({
      ...SNIFF_DEPS,
      env: { AI_GATEWAY_API_KEY: 'fake-gw-key', TYPESAFE_API_KEY: 'fake-ts-key' },
      fetchImpl: vi.fn(async () => jsonResponse(200, { name: 'jev', release_date: '2026-09-15' })),
    });
    const row = statusOf(result.checks, 'judge credential');
    expect(row.status).toBe('info');
    expect(row.detail).toContain('config selects vercel');
  });

  test('config missing reports a fail row for no vetkit.config.ts', async () => {
    const result = await runDoctor({
      ...PASSING_DEPS,
      configExists: () => false,
      env: { TYPESAFE_API_KEY: 'fake-key' },
      fetchImpl: vi.fn(async () => jsonResponse(200, { name: 'jev', release_date: '2026-09-15' })),
    });
    const row = statusOf(result.checks, 'config');
    expect(row.status).toBe('fail');
    expect(row.detail).toContain('no vetkit.config.ts');
  });

  test('endpoint 503 is a warn row, not a fail', async () => {
    const result = await runDoctor({
      ...PASSING_DEPS,
      env: { TYPESAFE_API_KEY: 'fake-key' },
      fetchImpl: vi.fn(async () => new Response('service unavailable', { status: 503 })),
    });
    const row = statusOf(result.checks, 'judge endpoint health');
    expect(row.status).toBe('warn');
    expect(row.detail).toContain('503');
    expect(result.exitCode).toBe(0);
  });

  test('401 is a fail row and exit code 1 without --strict', async () => {
    const result = await runDoctor({
      ...PASSING_DEPS,
      env: { TYPESAFE_API_KEY: 'fake-key' },
      fetchImpl: vi.fn(async () => jsonResponse(401, {})),
    });
    expect(statusOf(result.checks, 'judge endpoint health').status).toBe('fail');
    expect(result.exitCode).toBe(1);
    const sniffed = await runDoctor({
      ...SNIFF_DEPS,
      env: { TYPESAFE_API_KEY: 'fake-key' },
      fetchImpl: vi.fn(async () => jsonResponse(401, {})),
    });
    expect(statusOf(sniffed.checks, 'judge endpoint health').status).toBe('fail');
  });

  test('403 authentication_error is a fail row', async () => {
    const result = await runDoctor({
      ...PASSING_DEPS,
      env: { TYPESAFE_API_KEY: 'fake-key' },
      fetchImpl: vi.fn(async () =>
        jsonResponse(403, { detail: { error_type: 'authentication_error' } }),
      ),
    });
    expect(statusOf(result.checks, 'judge endpoint health').status).toBe('fail');
    expect(result.exitCode).toBe(1);
  });

  test('402 stays a warn row', async () => {
    const result = await runDoctor({
      ...PASSING_DEPS,
      env: { TYPESAFE_API_KEY: 'fake-key' },
      fetchImpl: vi.fn(async () => jsonResponse(402, {})),
    });
    expect(statusOf(result.checks, 'judge endpoint health').status).toBe('warn');
    expect(result.exitCode).toBe(0);
  });

  test('no bun or lefthook row in either mode', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { name: 'jev' }));
    const env = { TYPESAFE_API_KEY: 'fake-key' };
    const configured = await runDoctor({ ...PASSING_DEPS, env, fetchImpl });
    const sniffed = await runDoctor({ ...SNIFF_DEPS, env, fetchImpl });
    for (const { checks } of [configured, sniffed]) {
      const names = checks.map((c) => c.name);
      expect(names).not.toContain('bun');
      expect(names).not.toContain('lefthook');
    }
  });

  test('the Cloudflare pair is one credential, joined with +', async () => {
    const row = statusOf(
      (await runDoctor({ ...SNIFF_DEPS, env: {}, fetchImpl: vi.fn() })).checks,
      'judge credential',
    );
    expect(row.detail).toContain('CLOUDFLARE_API_TOKEN+CLOUDFLARE_ACCOUNT_ID=<unset>');
    expect(row.detail).not.toContain('CLOUDFLARE_API_TOKEN=<unset>');
    expect(row.detail).not.toContain('CLOUDFLARE_ACCOUNT_ID=<unset>');
    expect(row.detail).toMatch(/set one of .*CLOUDFLARE_API_TOKEN\+CLOUDFLARE_ACCOUNT_ID/);
    expect(row.detail).not.toMatch(/CLOUDFLARE_API_TOKEN, /);
  });

  test('a partly set Cloudflare pair shows each name and names the missing one', async () => {
    const row = statusOf(
      (
        await runDoctor({
          ...SNIFF_DEPS,
          env: { CLOUDFLARE_API_TOKEN: 'fake-cf-token' },
          fetchImpl: vi.fn(),
        })
      ).checks,
      'judge credential',
    );
    expect(row.status).toBe('fail');
    expect(row.detail).toContain('CLOUDFLARE_API_TOKEN=<set>+CLOUDFLARE_ACCOUNT_ID=<unset>');
    expect(row.detail).toMatch(/CLOUDFLARE_ACCOUNT_ID is missing/);
    expect(row.detail).not.toContain('fake-cf-token');
  });

  describe('health-check HTTP error hints', () => {
    test('401 hints at an invalid credential', async () => {
      const result = await runDoctor({
        ...PASSING_DEPS,
        env: { TYPESAFE_API_KEY: 'fake-key' },
        fetchImpl: vi.fn(async () => jsonResponse(401, {})),
      });
      expect(statusOf(result.checks, 'judge endpoint health').detail).toMatch(/unauthorized/i);
      expect(statusOf(result.checks, 'judge endpoint health').status).toBe('fail');
    });

    test('402 hints at no credit or exhausted budget', async () => {
      const result = await runDoctor({
        ...PASSING_DEPS,
        env: { TYPESAFE_API_KEY: 'fake-key' },
        fetchImpl: vi.fn(async () => jsonResponse(402, {})),
      });
      expect(statusOf(result.checks, 'judge endpoint health').detail).toMatch(/credit|budget/i);
    });

    test('gateway 403 customer_verification_required hints at identity verification', async () => {
      const result = await runDoctor({
        ...SNIFF_DEPS,
        env: { AI_GATEWAY_API_KEY: 'fake-gw-key' },
        fetchImpl: vi.fn(async () =>
          jsonResponse(403, { error: { type: 'customer_verification_required' } }),
        ),
      });
      expect(statusOf(result.checks, 'judge endpoint health').detail).toMatch(/verification/i);
    });

    test('gateway 403 free-tier model hints at a plan upgrade', async () => {
      const result = await runDoctor({
        ...SNIFF_DEPS,
        env: { AI_GATEWAY_API_KEY: 'fake-gw-key' },
        fetchImpl: vi.fn(async () =>
          jsonResponse(403, { error: { type: 'free_tier_model_not_available' } }),
        ),
      });
      expect(statusOf(result.checks, 'judge endpoint health').detail).toMatch(/free tier/i);
    });

    test("TypeSafe's 403 with nested detail.error_type hints at identity verification", async () => {
      const result = await runDoctor({
        ...PASSING_DEPS,
        env: { TYPESAFE_API_KEY: 'fake-ts-key' },
        fetchImpl: vi.fn(async () =>
          jsonResponse(403, { detail: { error_type: 'customer_verification_required' } }),
        ),
      });
      expect(statusOf(result.checks, 'judge endpoint health').detail).toMatch(/verification/i);
    });
  });

  test('vercel transport: reports zero-data-retention as best-effort and prints gateway routing metadata', async () => {
    const result = await runDoctor({
      ...SNIFF_DEPS,
      env: { AI_GATEWAY_API_KEY: 'fake-gw-key' },
      fetchImpl: vi.fn(async () =>
        jsonResponse(200, {
          name: 'jev',
          release_date: '2026-09-15',
          finalProvider: 'typesafe-ai',
          credentialType: 'oauth',
        }),
      ),
    });
    const row = statusOf(result.checks, 'judge endpoint health');
    expect(row.status).toBe('pass');
    expect(row.detail).toMatch(/zero-data-retention/i);
    expect(row.detail).toMatch(/best-effort/i);
    expect(row.detail).toContain('finalProvider=typesafe-ai');
    expect(row.detail).toContain('credentialType=oauth');
  });

  test('no leak: a set credential never appears in full, only <set> unless --reveal-suffix', async () => {
    const secret = 'fake-gateway-secret-value-9999';
    const result = await runDoctor({
      ...SNIFF_DEPS,
      env: { AI_GATEWAY_API_KEY: secret },
      fetchImpl: vi.fn(async () => jsonResponse(200, { name: 'jev', release_date: '2026-09-15' })),
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(secret);
    expect(statusOf(result.checks, 'judge credential').detail).toContain('<set>');
  });

  test('--reveal-suffix shows only the last 4 characters of a set credential', async () => {
    const secret = 'fake-gateway-secret-value-9999';
    const result = await runDoctor({
      ...SNIFF_DEPS,
      env: { AI_GATEWAY_API_KEY: secret },
      fetchImpl: vi.fn(async () => jsonResponse(200, { name: 'jev', release_date: '2026-09-15' })),
      revealSuffix: true,
    });
    const detail = statusOf(result.checks, 'judge credential').detail;
    expect(detail).toContain(secret.slice(-4));
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  test('--strict promotes a warn (offline endpoint) into a failing exit code', async () => {
    const result = await runDoctor({
      ...PASSING_DEPS,
      env: { TYPESAFE_API_KEY: 'fake-key' },
      fetchImpl: vi.fn(async () => {
        throw new Error('network unreachable');
      }),
      strict: true,
    });
    expect(statusOf(result.checks, 'judge endpoint health').status).toBe('warn');
    expect(result.exitCode).toBe(1);
  });
});

describe('registerDoctor', () => {
  test('wires a doctor subcommand that prints JSON and reports the exit code', async () => {
    // --json is a global program option (createProgram); doctor reads it via optsWithGlobals.
    const program = new Command().option('--json');
    program.exitOverride();
    const lines: string[] = [];
    let exitCode: number | undefined;
    registerDoctor(program, {
      ...PASSING_DEPS,
      env: { TYPESAFE_API_KEY: 'fake-key' },
      fetchImpl: vi.fn(async () => jsonResponse(200, { name: 'jev', release_date: '2026-09-15' })),
      stdout: { write: (chunk: string) => lines.push(chunk) },
      setExitCode: (code) => {
        exitCode = code;
      },
    });
    await program.parseAsync(['doctor', '--json'], { from: 'user' });
    const parsed = parseJson(lines.join(''));
    expect(parsed).toMatchObject({ checks: expect.any(Array) });
    expect(exitCode).toBe(0);
  });
});

describe('docs/configuration.md env-docs', () => {
  test('lists exactly the env var names doctor.ts exports', () => {
    const docsPath = fileURLToPath(new URL('../../../../docs/configuration.md', import.meta.url));
    const content = readFileSync(docsPath, 'utf8');
    // Only the first table under "## Environment variables": other tables may follow it.
    const section = content.split('\n## Environment variables')[1]?.split('\n## ')[0] ?? '';
    const lines = section.split('\n');
    const start = lines.findIndex((line) => line.startsWith('|'));
    const tableLines = lines
      .slice(start)
      .filter((line, i, all) => all.slice(0, i + 1).every((l) => l.startsWith('|')))
      .slice(2); // drop the header row and the separator row
    const documented = new Set(
      tableLines.flatMap((line) => [...line.matchAll(/`([A-Z][A-Z0-9_]*)`/g)].map((m) => m[1])),
    );
    const exported = new Set(ENV_VARS.map((v) => v.name));
    expect(documented).toEqual(exported);
  });
});

describe('registerDoctor --json is global', () => {
  test('doctor defines no local --json option', () => {
    const program = new Command().option('--json');
    const doctor = registerDoctor(program);
    expect(doctor.options.some((o) => o.long === '--json')).toBe(false);
  });
});

describe('renderTable / renderJson', () => {
  test('renderTable without a painter is plain padded text', () => {
    const checks = [{ name: 'node', status: 'pass' as const, detail: 'v22.23.2 >= 22.12' }];
    expect(renderTable(checks)).toBe(`pass ${'node'.padEnd(22)} v22.23.2 >= 22.12`);
  });

  test('renderTable paints only the status word, keeping the padding outside it', () => {
    const checks = [{ name: 'bun', status: 'info' as const, detail: 'x' }];
    const table = renderTable(checks, (status, text) => `<${status}:${text}>`);
    expect(table).toBe(`<info:info> ${'bun'.padEnd(22)} x`);
  });

  test('renderTable includes every check name and status', () => {
    const checks = [{ name: 'node', status: 'pass' as const, detail: 'v22.23.2 >= 22.12' }];
    const table = renderTable(checks);
    expect(table).toContain('node');
    expect(table).toContain('pass');
  });

  test('renderJson round-trips the result', () => {
    const result = { checks: [], exitCode: 0 as const };
    expect(parseJson(renderJson(result))).toEqual(result);
  });
});

describe('doctor.ts vendor neutrality', () => {
  test('names no vendor outside comments (vendor metadata comes from @vetkit/judge-jev)', () => {
    const source = readFileSync(fileURLToPath(new URL('./doctor.ts', import.meta.url)), 'utf8');
    const code = source.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/(^|\s)\/\/.*$/gm, '$1');
    expect(code).not.toMatch(/vercel|typesafe\.ai|openrouter|cloudflare/i);
  });
});

async function configProject(config: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'vetkit-doctor-'));
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'vetkit.config.ts'), config);
  return root;
}

function adapter(id: string, extra: string): string {
  return `{ specVersion: 'v1', id: '${id}', ${extra} }`;
}

const INLINE_JUDGE = adapter(
  'inline-judge',
  `capabilities: { questionTypes: ['boolean'], maxStateTokens: 1000, pinned: true, transport: 'inline', model: 'm' },
  async doJudge() { throw new Error('not called'); }`,
);
const PRESET_JUDGE = `{ kind: 'typesafe-compatible', preset: 'typesafe', apiKeyEnv: 'MY_JUDGE_KEY' }`;
const GENERATOR_ENDPOINT = `{ kind: 'openai-compatible', baseURL: 'https://gen.example.test/v1', apiKeyEnv: 'MY_GEN_KEY', model: 'g' }`;
const GENERATOR_ADAPTER = adapter(
  'inline-generator',
  `capabilities: { structured: 'json_schema' }, async doGenerate() { return {}; }`,
);

function configSource(fields: Record<string, string>): string {
  const body = Object.entries(fields)
    .map(([key, value]) => `  ${key}: ${value},`)
    .join('\n');
  return `export default {\n${body}\n};\n`;
}

const LANGFUSE_DESCRIPTOR = `{ kind: 'langfuse', baseUrlEnv: 'LF_BASE_URL', publicKeyEnv: 'LF_PUBLIC_KEY', secretKeyEnv: 'LF_SECRET_KEY' }`;
const LANGFUSE_SINKS = `[${LANGFUSE_DESCRIPTOR}]`;

const OK_HEALTH = () => vi.fn(async () => jsonResponse(200, { name: 'jev' }));

describe('runDoctor with a resolved config (--config)', () => {
  const BASE = { nodeVersion: 'v22.23.2', bunPresent: () => true, lefthookInstalled: () => true };

  test('judge credential row names the env var the config selects, not the priority list', async () => {
    const cwd = await configProject(configSource({ judge: PRESET_JUDGE }));
    const result = await runDoctor({
      ...BASE,
      cwd,
      config: true,
      env: { MY_JUDGE_KEY: 'fake-judge-key' },
      fetchImpl: OK_HEALTH(),
    });
    const row = statusOf(result.checks, 'judge credential');
    expect(row.status).toBe('pass');
    expect(row.detail).toContain('MY_JUDGE_KEY=<set>');
    expect(row.detail).toContain('typesafe');
    expect(row.detail).not.toContain('AI_GATEWAY_API_KEY');
  });

  test('the configured judge key unset is a fail row even when a priority-list key is set', async () => {
    const cwd = await configProject(configSource({ judge: PRESET_JUDGE }));
    const result = await runDoctor({
      ...BASE,
      cwd,
      config: true,
      env: { AI_GATEWAY_API_KEY: 'fake-gw-key' },
      fetchImpl: OK_HEALTH(),
    });
    const row = statusOf(result.checks, 'judge credential');
    expect(row.status).toBe('fail');
    expect(row.detail).toContain('MY_JUDGE_KEY=<unset>');
    expect(result.exitCode).toBe(1);
  });

  test('health probes the configured preset with the configured key as the bearer', async () => {
    const cwd = await configProject(configSource({ judge: PRESET_JUDGE }));
    const fetchImpl = OK_HEALTH();
    await runDoctor({
      ...BASE,
      cwd,
      config: true,
      env: { MY_JUDGE_KEY: 'fake-judge-key', AI_GATEWAY_API_KEY: 'fake-gw-key' },
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      JEV_PRESETS.typesafe.health.url({}),
      expect.objectContaining({ headers: { Authorization: 'Bearer fake-judge-key' } }),
    );
  });

  test('an adapter judge whose transport is no preset supplies its own credential: no probe', async () => {
    const cwd = await configProject(configSource({ judge: INLINE_JUDGE }));
    const fetchImpl = OK_HEALTH();
    const result = await runDoctor({ ...BASE, cwd, config: true, env: {}, fetchImpl });
    expect(statusOf(result.checks, 'judge credential').status).toBe('pass');
    expect(statusOf(result.checks, 'judge credential').detail).toContain('inline-judge');
    expect(statusOf(result.checks, 'judge endpoint health').status).toBe('info');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('generator endpoint: its apiKeyEnv set is a pass row naming the variable', async () => {
    const cwd = await configProject(
      configSource({ judge: INLINE_JUDGE, generator: GENERATOR_ENDPOINT }),
    );
    const result = await runDoctor({
      ...BASE,
      cwd,
      config: true,
      env: { MY_GEN_KEY: 'fake-gen-key' },
      fetchImpl: OK_HEALTH(),
    });
    const row = statusOf(result.checks, 'generator credential');
    expect(row.status).toBe('pass');
    expect(row.detail).toContain('MY_GEN_KEY=<set>');
  });

  test('generator endpoint: its apiKeyEnv unset is a fail row naming the variable', async () => {
    const cwd = await configProject(
      configSource({ judge: INLINE_JUDGE, generator: GENERATOR_ENDPOINT }),
    );
    const result = await runDoctor({ ...BASE, cwd, config: true, env: {}, fetchImpl: OK_HEALTH() });
    const row = statusOf(result.checks, 'generator credential');
    expect(row.status).toBe('fail');
    expect(row.detail).toContain('MY_GEN_KEY=<unset>');
  });

  test('generator adapter object is a pass row naming the adapter', async () => {
    const cwd = await configProject(
      configSource({ judge: INLINE_JUDGE, generator: GENERATOR_ADAPTER }),
    );
    const result = await runDoctor({ ...BASE, cwd, config: true, env: {}, fetchImpl: OK_HEALTH() });
    const row = statusOf(result.checks, 'generator credential');
    expect(row.status).toBe('pass');
    expect(row.detail).toContain('inline-generator');
  });

  test('no generator and no sinks configured are info rows', async () => {
    const cwd = await configProject(configSource({ judge: INLINE_JUDGE }));
    const result = await runDoctor({ ...BASE, cwd, config: true, env: {}, fetchImpl: OK_HEALTH() });
    expect(statusOf(result.checks, 'generator credential').status).toBe('info');
    expect(statusOf(result.checks, 'sink credentials').status).toBe('info');
  });

  test('sink adapter objects pass; a bare sink name is a warn row naming it', async () => {
    const cwd = await configProject(
      configSource({ judge: INLINE_JUDGE, sinks: `[{ specVersion: 'v1', id: 'otel/logs' }]` }),
    );
    const ok = await runDoctor({ ...BASE, cwd, config: true, env: {}, fetchImpl: OK_HEALTH() });
    expect(statusOf(ok.checks, 'sink credentials').status).toBe('pass');
    expect(statusOf(ok.checks, 'sink credentials').detail).toContain('otel/logs');

    const named = await configProject(configSource({ judge: INLINE_JUDGE, sinks: `['my-sink'] ` }));
    const warn = await runDoctor({
      ...BASE,
      cwd: named,
      config: true,
      env: {},
      fetchImpl: OK_HEALTH(),
    });
    expect(statusOf(warn.checks, 'sink credentials').status).toBe('warn');
    expect(statusOf(warn.checks, 'sink credentials').detail).toContain('my-sink');
  });

  test('a sink descriptor with an unset *Env variable is a warn row naming it, exit code unchanged', async () => {
    const cwd = await configProject(configSource({ judge: INLINE_JUDGE, sinks: LANGFUSE_SINKS }));
    const result = await runDoctor({
      ...BASE,
      cwd,
      config: true,
      env: { LF_BASE_URL: 'https://lf.example.test', LF_PUBLIC_KEY: 'fake-lf-public-9999' },
      fetchImpl: OK_HEALTH(),
    });
    const row = statusOf(result.checks, 'sink credentials');
    expect(row.status).toBe('warn');
    expect(row.detail).toContain('LF_SECRET_KEY=<unset>');
    expect(row.detail).not.toContain('LF_PUBLIC_KEY=<unset>');
    expect(JSON.stringify(result)).not.toContain('fake-lf-public-9999');
    expect(result.exitCode).toBe(0);
  });

  test('every unset variable across descriptors is named in the warn row', async () => {
    const cwd = await configProject(
      configSource({
        judge: INLINE_JUDGE,
        sinks: `[{ kind: 'otel', endpoint: 'https://otel.example.test', headersEnv: 'OTEL_HDRS' }, ${LANGFUSE_DESCRIPTOR}]`,
      }),
    );
    const result = await runDoctor({ ...BASE, cwd, config: true, env: {}, fetchImpl: OK_HEALTH() });
    const row = statusOf(result.checks, 'sink credentials');
    expect(row.status).toBe('warn');
    for (const name of ['OTEL_HDRS', 'LF_BASE_URL', 'LF_PUBLIC_KEY', 'LF_SECRET_KEY']) {
      expect(row.detail).toContain(`${name}=<unset>`);
    }
  });

  test('all descriptor variables set: a pass row naming the descriptor and its variables, not "supply their own credentials"', async () => {
    const cwd = await configProject(configSource({ judge: INLINE_JUDGE, sinks: LANGFUSE_SINKS }));
    const result = await runDoctor({
      ...BASE,
      cwd,
      config: true,
      env: {
        LF_BASE_URL: 'https://lf.example.test',
        LF_PUBLIC_KEY: 'fake-lf-public-9999',
        LF_SECRET_KEY: 'fake-lf-secret-8888',
      },
      fetchImpl: OK_HEALTH(),
    });
    const row = statusOf(result.checks, 'sink credentials');
    expect(row.status).toBe('pass');
    expect(row.detail).toContain('langfuse');
    expect(row.detail).toContain('LF_SECRET_KEY=<set>');
    expect(row.detail).not.toContain('supply their own credentials');
    expect(JSON.stringify(result)).not.toContain('fake-lf-secret-8888');
  });

  test('a set credential is never printed in full in any config-derived row', async () => {
    const cwd = await configProject(
      configSource({ judge: PRESET_JUDGE, generator: GENERATOR_ENDPOINT }),
    );
    const result = await runDoctor({
      ...BASE,
      cwd,
      config: true,
      env: { MY_JUDGE_KEY: 'fake-judge-secret-1111', MY_GEN_KEY: 'fake-gen-secret-2222' },
      fetchImpl: OK_HEALTH(),
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('fake-judge-secret-1111');
    expect(serialized).not.toContain('fake-gen-secret-2222');
  });
});

describe('runDoctor without a config file', () => {
  test('generator and sink rows keep their no-config text', async () => {
    const result = await runDoctor({
      ...PASSING_DEPS,
      configExists: () => false,
      env: { TYPESAFE_API_KEY: 'fake-key' },
      fetchImpl: vi.fn(async () => jsonResponse(200, { name: 'jev' })),
    });
    expect(statusOf(result.checks, 'generator credential')).toEqual({
      name: 'generator credential',
      status: 'warn',
      detail: 'no vetkit.config.ts — cannot determine which generator credential is required',
    });
    expect(statusOf(result.checks, 'sink credentials')).toEqual({
      name: 'sink credentials',
      status: 'warn',
      detail: 'no vetkit.config.ts — cannot determine which sink credentials are required',
    });
  });
});
