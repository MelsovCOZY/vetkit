import { statSync, utimesSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, expect, test } from 'vitest';
import { ensureCliBuilt } from './build-cli.js';

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
