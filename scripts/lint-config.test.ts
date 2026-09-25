import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

// NOTE: this is a script, not packages/*/src — the repo-wide "raw JSON.parse is banned,
// use safeParseJson" rule applies only to packages/*/src (see docs/contracts/j0.md), so
// the JSON.parse below (reading .oxlintrc.json) is not itself a violation.

const rootDir = path.resolve(import.meta.dirname, '..');
const oxlintBin = path.join(rootDir, 'node_modules/.bin/oxlint');
const tsgolintBin = path.join(rootDir, 'node_modules/.bin/tsgolint');
const fixturesConfig = path.join(rootDir, 'scripts/fixtures/lint-bad/.oxlintrc.json');
const banScript = path.join(rootDir, 'scripts/ban-raw-json-parse.sh');

function runOxlintOnFixture(relativeFile: string) {
  const result = spawnSync(oxlintBin, ['-c', fixturesConfig, relativeFile], {
    cwd: rootDir,
    encoding: 'utf8',
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe('scripts/fixtures/lint-bad fixtures', () => {
  test('adapter importing @vetkit/core fails no-restricted-imports naming the adapters rule', () => {
    const { status, output } = runOxlintOnFixture(
      'scripts/fixtures/lint-bad/packages/judge-jev/src/restricted-import.ts',
    );
    expect(status).toBe(1);
    expect(output).toContain('no-restricted-imports');
    expect(output).toContain('adapters import only @vetkit/spec');
  });

  test('`export * from` fails oxc/no-barrel-file', () => {
    const { status, output } = runOxlintOnFixture('scripts/fixtures/lint-bad/barrel.ts');
    expect(status).toBe(1);
    expect(output).toContain('no-barrel-file');
  });

  test('`any` fails typescript/no-explicit-any at error level', () => {
    const { status, output } = runOxlintOnFixture('scripts/fixtures/lint-bad/explicit-any.ts');
    expect(status).toBe(1);
    expect(output).toContain('no-explicit-any');
  });

  test('non-null assertion fails typescript/no-non-null-assertion at error level', () => {
    const { status, output } = runOxlintOnFixture(
      'scripts/fixtures/lint-bad/non-null-assertion.ts',
    );
    expect(status).toBe(1);
    expect(output).toContain('no-non-null-assertion');
  });
});

describe('scripts/ban-raw-json-parse.sh', () => {
  const plantedFile = path.join(rootDir, 'packages/core/src/__lint-config-test-planted.ts');

  afterEach(() => {
    if (existsSync(plantedFile)) rmSync(plantedFile);
  });

  test('exits 1 when a raw JSON.parse( is planted under packages/*/src', () => {
    mkdirSync(path.dirname(plantedFile), { recursive: true });
    writeFileSync(plantedFile, "export const parsed = JSON.parse('{}');\n");

    const result = spawnSync(banScript, [], { cwd: rootDir, encoding: 'utf8' });

    expect(result.status).toBe(1);
  });
});

describe('type-aware linting', () => {
  test('tsgolint banner mentions tsgolint', () => {
    const result = spawnSync(tsgolintBin, ['--help'], { encoding: 'utf8' });
    expect(`${result.stdout}${result.stderr}`).toContain('tsgolint');
  });
});

describe('.oxlintrc.json', () => {
  test('lists correctness and suspicious categories at error', () => {
    const config = JSON.parse(readFileSync(path.join(rootDir, '.oxlintrc.json'), 'utf8')) as {
      categories?: Record<string, string>;
    };
    expect(config.categories?.correctness).toBe('error');
    expect(config.categories?.suspicious).toBe('error');
  });
});
