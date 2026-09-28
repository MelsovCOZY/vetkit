import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

const PASSING_DEPS = {
  nodeVersion: 'v22.23.2',
  bunPresent: () => true,
  lefthookInstalled: () => true,
  configExists: () => true,
};

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
      ...PASSING_DEPS,
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
      ...PASSING_DEPS,
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

  describe('health-check HTTP error hints', () => {
    test('401 hints at an invalid credential', async () => {
      const result = await runDoctor({
        ...PASSING_DEPS,
        env: { TYPESAFE_API_KEY: 'fake-key' },
        fetchImpl: vi.fn(async () => jsonResponse(401, {})),
      });
      expect(statusOf(result.checks, 'judge endpoint health').detail).toMatch(/unauthorized/i);
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
        ...PASSING_DEPS,
        env: { AI_GATEWAY_API_KEY: 'fake-gw-key' },
        fetchImpl: vi.fn(async () =>
          jsonResponse(403, { error: { type: 'customer_verification_required' } }),
        ),
      });
      expect(statusOf(result.checks, 'judge endpoint health').detail).toMatch(/verification/i);
    });

    test('gateway 403 free-tier model hints at a plan upgrade', async () => {
      const result = await runDoctor({
        ...PASSING_DEPS,
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
      ...PASSING_DEPS,
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
      ...PASSING_DEPS,
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
      ...PASSING_DEPS,
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
    const tableLines = content
      .split('\n')
      .filter((line) => line.startsWith('|'))
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
