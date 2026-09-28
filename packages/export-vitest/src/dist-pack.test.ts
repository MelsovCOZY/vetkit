// Regression test for mol-aq4.14: `bun run build` did not copy templates/scorer.ts.tmpl into
// dist, so the built CLI's `vet export --to vitest` crashed with ENOENT reading
// packages/export-vitest/dist/templates/scorer.ts.tmpl (emit-scorer.ts's TEMPLATE_PATH is
// resolved relative to its own, built, module location). Unit tests elsewhere in this package
// alias @vetkit/spec to source via vitest.config.ts and import emit-scorer.ts directly, so
// they never touch dist and never caught this. These two tests prove the fix at the dist
// level: dist/index.js runs emitScorer without ENOENT, and the packed tarball's file list
// contains the template.
//
// This reads the package's own already-built dist/ instead of rebuilding it here: an earlier
// version ran `rm -rf dist; bun run build` in a beforeAll, which raced with the cli project's
// tests (packages/cli/src/test-support/build-cli.ts) spawning the built CLI against this same
// dist/ from a parallel vitest worker — dist briefly didn't exist mid-rebuild, and 31 cli
// tests failed with ERR_MODULE_NOT_FOUND (mol-aq4.15). The root `bun run build` (which every
// documented verify command, and CI, runs before `bun run test`) always builds this package's
// real dist/ first, so it is current here; requireBuilt() fails loudly instead of silently
// skipping if it somehow isn't.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';
import type { Criterion } from '@vetkit/spec';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST_INDEX = join(PACKAGE_ROOT, 'dist/index.js');

function requireBuilt(path: string): void {
  if (!existsSync(path)) {
    throw new Error(`${path} is missing — run \`bun run build\` before this test`);
  }
}

const cleanupDirs: string[] = [];

afterAll(() => {
  for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function booleanCriterion(): Criterion {
  return {
    id: 'helpful',
    type: 'boolean',
    instructions: 'Is the reply helpful?',
    escape: 'not answerable',
    polarity: 'pass_when_true',
    channel: 'quality',
    provenance: { traceIds: [] },
    wordingHash: 'a'.repeat(64),
  };
}

interface DistModule {
  emitScorer: (criterion: Criterion, lock: undefined) => { path: string; source: string };
}

describe('built dist (mol-aq4.14)', () => {
  test('dist/index.js emits a scorer without ENOENT', async () => {
    requireBuilt(DIST_INDEX);
    const mod: unknown = await import(pathToFileURL(DIST_INDEX).href);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const { emitScorer } = mod as DistModule;
    const result = emitScorer(booleanCriterion(), undefined);
    expect(result.path).toBe('scorers/helpful.ts');
    expect(result.source).toContain('helpful');
  });

  test('the packed tarball contains dist/templates/scorer.ts.tmpl', () => {
    requireBuilt(DIST_INDEX);
    const tarballDir = mkdtempSync(join(tmpdir(), 'vetkit-export-vitest-tarball-'));
    cleanupDirs.push(tarballDir);
    const packOut = spawnSync('bun', ['pm', 'pack', '--quiet', '--destination', tarballDir], {
      cwd: PACKAGE_ROOT,
      encoding: 'utf8',
    });
    expect(packOut.status, packOut.stdout + packOut.stderr).toBe(0);
    const tgzPath = packOut.stdout.trim();

    const extractDir = mkdtempSync(join(tmpdir(), 'vetkit-export-vitest-extract-'));
    cleanupDirs.push(extractDir);
    const tarOut = spawnSync('tar', ['-xzf', tgzPath, '-C', extractDir], { encoding: 'utf8' });
    expect(tarOut.status, tarOut.stdout + tarOut.stderr).toBe(0);

    const templatesDir = join(extractDir, 'package', 'dist', 'templates');
    expect(existsSync(templatesDir)).toBe(true);
    expect(readdirSync(templatesDir)).toContain('scorer.ts.tmpl');
  });
});
