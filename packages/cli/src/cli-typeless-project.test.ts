import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, test } from 'vitest';
import { ensureCliBuilt } from './test-support/build-cli.js';

// A consumer project whose package.json has no "type" field (the `npm init -y` default).
// vetkit.config.ts uses ESM syntax, so Node's import() of it emits MODULE_TYPELESS_PACKAGE_JSON;
// the bin drops that one warning and leaves every other warning to print as Node does.

const binPath = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
const fixtureDir = fileURLToPath(new URL('../../../fixtures/cli/run', import.meta.url));

beforeAll(async () => {
  await ensureCliBuilt();
}, 180_000);

function typelessProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vetkit-typeless-'));
  cpSync(fixtureDir, dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{"name":"typeless","version":"1.0.0"}\n');
  return dir;
}

function childEnv(): NodeJS.ProcessEnv {
  return { ...process.env, NO_COLOR: '1', VETKIT_FIXTURE_MODE: 'pass', VETKIT_FIXTURE_KEY: 'k' };
}

describe('vet in a project whose package.json has no type field', () => {
  test('Node itself emits MODULE_TYPELESS_PACKAGE_JSON when it imports the scratch config', () => {
    const dir = typelessProject();
    const configUrl = pathToFileURL(join(dir, 'vetkit.config.ts')).href;
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', `await import(${JSON.stringify(configUrl)});`],
      { cwd: dir, encoding: 'utf8', env: childEnv(), timeout: 10_000 },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('MODULE_TYPELESS_PACKAGE_JSON');
  });

  test('vet run prints no MODULE_TYPELESS line on stderr', () => {
    const result = spawnSync(process.execPath, [binPath, 'run', '--json'], {
      cwd: typelessProject(),
      encoding: 'utf8',
      env: childEnv(),
      timeout: 30_000,
    });
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('MODULE_TYPELESS');
  });

  test('a warning with another code raised while the config loads still prints through Node', () => {
    const dir = typelessProject();
    appendFileSync(
      join(dir, 'vetkit.config.ts'),
      `process.emitWarning('probe warning', { code: 'VETKIT_PROBE_WARNING' });\n`,
    );
    const result = spawnSync(process.execPath, [binPath, 'run', '--json'], {
      cwd: dir,
      encoding: 'utf8',
      env: childEnv(),
      timeout: 30_000,
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('[VETKIT_PROBE_WARNING] Warning: probe warning');
    expect(result.stderr).not.toContain('MODULE_TYPELESS');
  });
});
