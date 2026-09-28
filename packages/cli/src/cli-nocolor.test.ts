import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, test } from 'vitest';
import { ENV_VARS } from './commands/doctor.ts';
import { EXIT_FAILED } from './errors.ts';
import { CEV_EXIT, colorEnabled } from './output.ts';
import { ensureCliBuilt } from './test-support/build-cli.js';

const binPath = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
// oxlint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/;

beforeAll(async () => {
  await ensureCliBuilt();
}, 180_000);

function runDoctor(colorEnv: Record<string, string>, flags: string[] = []) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const v of ENV_VARS) delete env[v.name];
  delete env.NO_COLOR;
  delete env.FORCE_COLOR;
  delete env.CI;
  return spawnSync(process.execPath, [binPath, ...flags, 'doctor'], {
    encoding: 'utf8',
    env: { ...env, ...colorEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  });
}

describe('NO_COLOR / FORCE_COLOR', () => {
  test('NO_COLOR=1 vet doctor prints no ANSI escape sequences', () => {
    const result = runDoctor({ NO_COLOR: '1' });
    expect(result.stdout.length).toBeGreaterThan(0);
    expect(result.stdout).not.toMatch(ANSI);
    expect(result.stderr).not.toMatch(ANSI);
  });

  test('FORCE_COLOR=1 NO_COLOR=1 vet doctor colours its output (FORCE_COLOR wins)', () => {
    const result = runDoctor({ NO_COLOR: '1', FORCE_COLOR: '1' });
    expect(result.stdout).toMatch(ANSI);
  });

  test('coloured and uncoloured doctor output carry the same text', () => {
    const plain = runDoctor({ NO_COLOR: '1' }).stdout;
    const forced = runDoctor({ FORCE_COLOR: '1' }).stdout;
    expect(forced.replaceAll(new RegExp(ANSI.source, 'g'), '')).toBe(plain);
  });
});

describe('stderr log lines follow the same colour rule', () => {
  test('FORCE_COLOR=1 NO_COLOR=1 vet --verbose doctor colours stderr log lines', () => {
    const result = runDoctor({ NO_COLOR: '1', FORCE_COLOR: '1' }, ['--verbose']);
    expect(result.stderr).toContain('running doctor');
    expect(result.stderr).toMatch(ANSI);
  });

  test('NO_COLOR=1 vet --verbose doctor leaves stderr log lines uncoloured', () => {
    const result = runDoctor({ NO_COLOR: '1' }, ['--verbose']);
    expect(result.stderr).toContain('running doctor');
    expect(result.stderr).not.toMatch(ANSI);
  });

  test('vet --no-color --verbose doctor leaves stderr log lines uncoloured', () => {
    const result = runDoctor({}, ['--no-color', '--verbose']);
    expect(result.stderr).toContain('running doctor');
    expect(result.stderr).not.toMatch(ANSI);
  });
});

describe('CEV_EXIT.FAILED', () => {
  test('is EXIT_FAILED from errors.ts', () => {
    expect(CEV_EXIT.FAILED).toBe(EXIT_FAILED);
  });
});

describe('colorEnabled', () => {
  test('FORCE_COLOR wins over NO_COLOR', () => {
    expect(colorEnabled({ env: { FORCE_COLOR: '1', NO_COLOR: '1' }, isTTY: false })).toBe(true);
  });

  test('a non-empty NO_COLOR disables colour on a TTY', () => {
    expect(colorEnabled({ env: { NO_COLOR: '1' }, isTTY: true })).toBe(false);
  });

  test('an empty NO_COLOR is ignored', () => {
    expect(colorEnabled({ env: { NO_COLOR: '' }, isTTY: true })).toBe(true);
  });

  test('--no-color disables colour on a TTY', () => {
    expect(colorEnabled({ env: {}, isTTY: true, flag: false })).toBe(false);
  });

  test('a non-TTY without FORCE_COLOR is uncoloured', () => {
    expect(colorEnabled({ env: {}, isTTY: false })).toBe(false);
  });
});
