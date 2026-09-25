import { spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
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
