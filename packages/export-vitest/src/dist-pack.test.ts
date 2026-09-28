// Regression test for mol-aq4.14: `bun run build` did not copy templates/scorer.ts.tmpl into
// dist, so the built CLI's `vet export --to vitest` crashed with ENOENT reading
// packages/export-vitest/dist/templates/scorer.ts.tmpl (emit-scorer.ts's TEMPLATE_PATH is
// resolved relative to its own, built, module location). Unit tests elsewhere in this package
// alias @vetkit/spec to source via vitest.config.ts and import emit-scorer.ts directly, so
// they never touch dist and never caught this. These two tests build the real package output
// and prove the fix at that level: dist/index.js runs emitScorer without ENOENT, and the
// packed tarball's file list contains the template. @vetkit/spec is built too (not aliased),
// because Bun resolves the workspace bare specifier `@vetkit/spec` from the real
// @vetkit/spec/dist output (its package.json `exports` point only at dist), not from src.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Criterion } from '@vetkit/spec';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SPEC_ROOT = fileURLToPath(new URL('../../spec', import.meta.url));

function build(cwd: string): void {
  rmSync(join(cwd, 'dist'), { recursive: true, force: true });
  const result = spawnSync('bun', ['run', 'build'], { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`build failed in ${cwd}:\n${result.stdout}\n${result.stderr}`);
  }
}

const cleanupDirs: string[] = [];

beforeAll(() => {
  // @vetkit/spec's package.json `exports` point only at ./dist (no path-mapped alias at
  // runtime, unlike vitest's own resolver), so the workspace bare specifier `@vetkit/spec`
  // that dist/index.js imports needs real dist output to resolve.
  build(SPEC_ROOT);
  build(PACKAGE_ROOT);
}, 60_000);

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
    const mod: unknown = await import(pathToFileURL(join(PACKAGE_ROOT, 'dist/index.js')).href);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const { emitScorer } = mod as DistModule;
    const result = emitScorer(booleanCriterion(), undefined);
    expect(result.path).toBe('scorers/helpful.ts');
    expect(result.source).toContain('helpful');
  });

  test('the packed tarball contains dist/templates/scorer.ts.tmpl', () => {
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
