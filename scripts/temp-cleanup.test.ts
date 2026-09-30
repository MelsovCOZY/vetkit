import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const globalSetupFile = join(repoRoot, 'vitest.global-setup.ts');

const TEMP_VARS = ['TMPDIR', 'TMP', 'TEMP'] as const;

describe('one temp root per test run', () => {
  const saved = TEMP_VARS.map((name) => [name, process.env[name]] as const);

  afterEach(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  test('the root vitest config wires the global setup file by absolute path', async () => {
    const config = (await import('../vitest.config.ts')).default;
    expect([config.test?.globalSetup ?? []].flat()).toContain(globalSetupFile);
    expect(existsSync(globalSetupFile)).toBe(true);
  });

  test('the global setup points TMPDIR, TMP and TEMP at a fresh directory under the previous temp dir', async () => {
    const { default: setup } = await import('../vitest.global-setup.ts');
    const base = tmpdir();
    const teardown = setup();
    try {
      const runDir = tmpdir();
      expect(runDir).not.toBe(base);
      expect(dirname(runDir)).toBe(base);
      expect(statSync(runDir).isDirectory()).toBe(true);
      for (const name of TEMP_VARS) expect(process.env[name]).toBe(runDir);
    } finally {
      teardown();
    }
  });

  test('teardown removes the run directory with everything tests left in it and restores the environment', async () => {
    const { default: setup } = await import('../vitest.global-setup.ts');
    const base = tmpdir();
    const teardown = setup();
    const runDir = tmpdir();
    const leftover = mkdtempSync(join(tmpdir(), 'vetkit-leftover-'));
    expect(dirname(leftover)).toBe(runDir);

    teardown();

    expect(existsSync(leftover)).toBe(false);
    expect(existsSync(runDir)).toBe(false);
    expect(tmpdir()).toBe(base);
    for (const [name, value] of saved) expect(process.env[name]).toBe(value);
  });
});

// Each smoke removes its scratch root when it exits, whatever the outcome, unless the caller
// chose the location with VETKIT_SMOKE_DIR: that directory belongs to the caller.
describe.each([
  { script: 'smoke-release.sh', workVar: 'WORK' },
  { script: 'smoke-gate-share-ci.sh', workVar: 'BASE' },
  { script: 'smoke-first-run.sh', workVar: 'WORK' },
])('scripts/$script scratch cleanup', ({ script, workVar }) => {
  const src = readFileSync(join(repoRoot, 'scripts', script), 'utf8');

  // The body of the function the script registers with `trap <name> EXIT`.
  function exitTrapBody(): string {
    const name = /^trap (\w+) EXIT$/m.exec(src)?.[1];
    if (name === undefined) return '';
    const start = src.indexOf(`\n${name}() {`);
    if (start === -1) return '';
    const oneLine = src.slice(start + 1, src.indexOf('\n', start + 1));
    if (oneLine.trimEnd().endsWith('}')) return oneLine;
    return src.slice(start + 1, src.indexOf('\n}', start + 1));
  }

  test('registers exactly one EXIT trap', () => {
    expect(src.match(/^\s*trap .* EXIT$/gm)).toHaveLength(1);
    expect(exitTrapBody()).not.toBe('');
  });

  test('the EXIT trap removes the scratch root only when VETKIT_SMOKE_DIR is unset', () => {
    const guarded = new RegExp(
      `\\[ -z "\\$\\{VETKIT_SMOKE_DIR:-\\}" \\] && rm -rf [^\\n]*"\\$${workVar}"`,
    );
    expect(exitTrapBody()).toMatch(guarded);
  });

  test('the scratch root still defaults to a path under TMPDIR and honours VETKIT_SMOKE_DIR', () => {
    expect(src).toMatch(
      new RegExp(`^${workVar}="\\$\\{VETKIT_SMOKE_DIR:-.*\\$\\{TMPDIR:-/tmp\\}/vetkit-`, 'm'),
    );
  });
});
