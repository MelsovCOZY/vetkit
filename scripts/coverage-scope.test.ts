// Regression guard: coverage once had no `include`, so every file a test happened to load
// was counted - built `packages/*/dist/*.js` (loaded by tests that spawn or import the built
// CLI) and `fixtures/**/vetkit.config.ts` among them. That dragged the totals far below the
// thresholds and `bun run test` exited 1 with every test passing. These assertions pin the
// coverage scope to package sources so the thresholds measure the code the tests are about.
import { readFileSync } from 'node:fs';
import { matchesGlob } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const coverage = (await import('../vitest.config.ts')).default.test?.coverage;
const include = coverage?.include;
const exclude = coverage?.exclude ?? [];

// Mirrors how vitest decides: with no `include`, every loaded file that is not excluded
// is counted; with one, a file must match it and must not be excluded.
const isCounted = (file: string): boolean =>
  (include === undefined || include.some((pattern) => matchesGlob(file, pattern))) &&
  !exclude.some((pattern) => matchesGlob(file, pattern));

test('coverage.include only names package sources', () => {
  const patterns = include ?? [];
  expect(patterns.length).toBeGreaterThan(0);
  for (const pattern of patterns) {
    expect(pattern).toMatch(/^packages\/\*\/src\//);
  }
});

test('a package source file is counted', () => {
  expect(isCounted('packages/cli/src/commands/run.ts')).toBe(true);
  expect(isCounted('packages/spec/src/index.ts')).toBe(true);
});

test.each([
  'packages/cli/dist/bin.js',
  'packages/export-vitest/dist/index.js',
  'fixtures/cli/run/vetkit.config.ts',
  'examples/quickstart/vetkit.config.ts',
  'e2e/j1.e2e.test.ts',
  'packages/cli/e2e/j1.e2e.test.ts',
  'scripts/pack.ts',
  'spike/probe.ts',
  'action/index.ts',
])('%s is not counted', (file) => {
  expect(isCounted(file)).toBe(false);
});

test('type tests are not counted, since they are type-checked and never executed', () => {
  expect(isCounted('packages/spec/src/errors.test-d.ts')).toBe(false);
});

// node:path's glob matcher is experimental on Node 22.18 and prints an ExperimentalWarning
// into every test run that loads it; the patterns here are literal enough for a local check.
test("this file does not use node:path's experimental glob matcher", () => {
  const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  expect(source).not.toContain(['matches', 'Glob'].join(''));
});

test.each(['lines', 'branches', 'functions', 'statements'] as const)(
  'a global %s threshold is enforced',
  (metric) => {
    const threshold = coverage?.thresholds?.[metric];
    expect(threshold).toBeTypeOf('number');
    expect(threshold).toBeGreaterThan(0);
  },
);
