import { statSync, utimesSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { beforeAll, expect, test } from 'vitest';
import { BUILD_ORDER, ensureCliBuilt } from './build-cli.js';

const require = createRequire(import.meta.url);
const cliPkg: { dependencies?: Record<string, string> } = require('../../package.json');
const workspaceDeps = Object.keys(cliPkg.dependencies ?? {}).filter((name) =>
  name.startsWith('@vetkit/'),
);

const coreEntry = fileURLToPath(new URL('../../../core/dist/index.js', import.meta.url));
const specIndex = fileURLToPath(new URL('../../../spec/src/index.ts', import.meta.url));

beforeAll(async () => {
  await ensureCliBuilt();
}, 180_000);

// Other tests plant files in packages/*/src mid-run (scripts/tsconfig.test.ts writes
// packages/spec/src/__tmp_te.ts), which makes that src newer than its dist. A rebuild
// at that point runs tsdown, which cleans every dist/ first, so core's dist vanishes
// under the cli bins other workers are spawning (mol-p4a.10). Once built for a run,
// ensureCliBuilt must not build again.
test('a src file that turns newer than dist mid-run does not rebuild (and clean) dist', async () => {
  const before = statSync(coreEntry);
  const original = statSync(specIndex);
  const future = new Date(Date.now() + 60_000);
  utimesSync(specIndex, future, future);
  try {
    await ensureCliBuilt();
  } finally {
    utimesSync(specIndex, original.atime, original.mtime);
  }
  const after = statSync(coreEntry);
  expect({ ino: after.ino, mtimeMs: after.mtimeMs }).toEqual({
    ino: before.ino,
    mtimeMs: before.mtimeMs,
  });
}, 180_000);

// mol-76a.12: a workspace dependency missing from BUILD_ORDER has no dist/ in spawned tests, so
// any static import of it from the cli bin fails.
test.each(workspaceDeps)('cli dependency %s is built before the spawned cli tests', (name) => {
  expect(BUILD_ORDER).toContain(name.slice('@vetkit/'.length));
});

test('the cli has at least one @vetkit/* workspace dependency to check', () => {
  expect(workspaceDeps).toContain('@vetkit/generator-openai-compatible');
});
