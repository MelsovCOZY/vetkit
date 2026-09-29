// Bug fix: the e2e project's include only ever matched
// e2e/**, so `vitest run --project e2e <packages/*/e2e file>` found nothing and exited 0
// (a false green) instead of failing, while the default per-package projects silently
// collected (and skipped) the same file. These assertions pin the resolved project shapes
// so a regression on either side shows up here rather than as a silent false green.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { expect, test, vi } from 'vitest';

// This repo's vitest.config.ts only ever builds the plain-object project form.
type ProjectConfig = {
  test?: { name?: string; include?: string[]; exclude?: string[] };
};

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

test('e2e project also collects packages/*/e2e/**/*.e2e.test.ts, not just top-level e2e/**', async () => {
  vi.stubEnv('CEV_E2E', '1');
  vi.resetModules();
  const config = (await import('../vitest.config.ts')).default;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const projects = (config.test?.projects ?? []) as ProjectConfig[];
  const e2eProject = projects.find((p) => p.test?.name === 'e2e');

  expect(e2eProject?.test?.include).toContain('packages/*/e2e/**/*.e2e.test.ts');
  expect(e2eProject?.test?.include).toContain('e2e/**/*.e2e.test.ts');
});

test('every package project excludes **/e2e/** so the default suite never collects it', async () => {
  vi.resetModules();
  const config = (await import('../vitest.config.ts')).default;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const projects = (config.test?.projects ?? []) as ProjectConfig[];
  const packageProjects = projects.filter(
    (p) => p.test?.name !== 'e2e' && p.test?.name !== 'scripts' && p.test?.name !== 'spike',
  );

  expect(packageProjects.length).toBeGreaterThan(0);
  for (const project of packageProjects) {
    expect(project.test?.exclude ?? []).toContain('**/e2e/**');
  }
});

test('the e2e/j1.e2e.test.ts import shim is removed', () => {
  const shimPath = join(repoRoot, 'e2e/j1.e2e.test.ts');
  expect(existsSync(shimPath)).toBe(false);
});
