import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { safeParseJson } from '@vetkit/spec';
import { beforeAll, describe, expect, test } from 'vitest';
import { ENV_VARS } from './commands/doctor.ts';
import { ensureCliBuilt } from './test-support/build-cli.js';

const require = createRequire(import.meta.url);
const binPath = fileURLToPath(new URL('../dist/bin.js', import.meta.url));

beforeAll(async () => {
  await ensureCliBuilt();
}, 180_000);

// No judge credential in the child env, so doctor never probes the network.
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const v of ENV_VARS) delete env[v.name];
  delete env.CEV_LOG_LEVEL;
  delete env.CI;
  return { ...env, ...extra };
}

function runVet(args: string[], extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, [binPath, ...args], {
    encoding: 'utf8',
    env: cleanEnv(extraEnv),
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  });
}

function parseJson(text: string): unknown {
  const result = safeParseJson<unknown>(text, {});
  if (!result.ok) throw result.error;
  return result.value;
}

describe('--json purity', () => {
  test('vet --version --json prints one JSON document with the package version', () => {
    const result = runVet(['--version', '--json']);
    expect(result.status).toBe(0);
    const pkgJson: { version: string } = require('../package.json');
    expect(parseJson(result.stdout)).toEqual({ version: pkgJson.version });
  });

  test('vet doctor --json prints only one JSON document on stdout', () => {
    const result = runVet(['doctor', '--json']);
    expect(parseJson(result.stdout)).toMatchObject({ checks: expect.any(Array) });
  });

  test('vet --json doctor (global flag before the command) prints the same JSON document', () => {
    const result = runVet(['--json', 'doctor']);
    expect(parseJson(result.stdout)).toMatchObject({ checks: expect.any(Array) });
  });

  test('--json --verbose keeps stdout a single JSON document and puts debug lines on stderr', () => {
    const result = runVet(['doctor', '--json', '--verbose']);
    expect(parseJson(result.stdout)).toMatchObject({ checks: expect.any(Array) });
    expect(result.stderr).toMatch(/^debug /m);
  });
});

describe('--quiet / --verbose / --version', () => {
  test('without --quiet a logger warning reaches stderr', () => {
    const result = runVet(['doctor', '--json'], { CEV_LOG_LEVEL: 'bogus' });
    expect(result.stderr).toContain('invalid CEV_LOG_LEVEL');
  });

  test('--quiet suppresses warn lines on stderr', () => {
    const result = runVet(['doctor', '--json', '--quiet'], { CEV_LOG_LEVEL: 'bogus' });
    expect(result.stderr).not.toContain('invalid CEV_LOG_LEVEL');
    expect(parseJson(result.stdout)).toMatchObject({ checks: expect.any(Array) });
  });

  test('without --verbose there are no debug lines', () => {
    const result = runVet(['doctor', '--json']);
    expect(result.stderr).not.toMatch(/^debug /m);
  });

  test('--verbose adds debug lines on stderr', () => {
    const result = runVet(['--verbose', 'doctor']);
    expect(result.stderr).toMatch(/^debug /m);
  });

  test('--version prints the package version', () => {
    const result = runVet(['--version']);
    const pkgJson: { version: string } = require('../package.json');
    expect(result.stdout.trim()).toBe(pkgJson.version);
    expect(result.status).toBe(0);
  });
});
