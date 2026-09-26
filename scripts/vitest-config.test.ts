import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { expect, test } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

test('runs under Node, not Bun', () => {
  expect(process.versions.bun).toBeUndefined();
});

test('blocks an unstubbed global fetch call with a guard naming vi.stubGlobal', () => {
  expect(() => globalThis.fetch('http://cev-test-network-blocked.invalid')).toThrow(
    /CevTestNetworkBlocked.*vi\.stubGlobal/,
  );
});

test('every packages/* project inherits the fetch guard from the root setup', () => {
  const guardFile = join(repoRoot, 'packages/spec/src/__guard.test.ts');
  writeFileSync(
    guardFile,
    `import { test } from 'vitest';\n\ntest('unstubbed fetch throws', () => {\n  (globalThis.fetch as (...args: unknown[]) => unknown)();\n});\n`,
  );
  try {
    const result = spawnSync('bun', ['x', 'vitest', 'run', '--project', 'spec'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toMatch(/CevTestNetworkBlocked.*vi\.stubGlobal/);
  } finally {
    rmSync(guardFile, { force: true });
  }
}, 30_000);

test('every @vetkit/<name> workspace package aliases to its own packages/<name>/src/index.ts', async () => {
  const config = (await import('../vitest.config.ts')).default;
  // resolve.alias is typed as Vite's AliasOptions (object or array form); this repo's
  // vitest.config.ts only ever builds the plain-object form.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const alias = (config.resolve?.alias ?? {}) as Record<string, string>;

  const scopedPackages = readdirSync(join(repoRoot, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const pkgJson: { name: string } = JSON.parse(
        readFileSync(join(repoRoot, 'packages', entry.name, 'package.json'), 'utf8'),
      );
      return { name: pkgJson.name, dir: entry.name };
    })
    .filter(({ name }) => name.startsWith('@vetkit/'));

  // Sanity check: this repo has more than one scoped package to alias, and the cli
  // package (npm name "vetkit", not "@vetkit/cli") must not appear.
  expect(scopedPackages.length).toBeGreaterThan(1);
  expect(Object.keys(alias)).not.toContain('vetkit');

  for (const { name, dir } of scopedPackages) {
    expect(alias[name]).toBe(join(repoRoot, 'packages', dir, 'src', 'index.ts'));
  }
});
