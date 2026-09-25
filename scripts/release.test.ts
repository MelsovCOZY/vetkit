import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import {
  checkNpmVersion,
  topoSortPackages,
  tgzFilenameFor,
  type PackageManifest,
} from './release-preflight.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES_DIR = join(ROOT, 'packages');
const WORKFLOW_PATH = join(ROOT, '.github/workflows/release.yml');
const CHANGESET_CONFIG_PATH = join(ROOT, '.changeset/config.json');

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function loadRealManifests(): Record<string, PackageManifest> {
  const dirs = readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  const out: Record<string, PackageManifest> = {};
  for (const dir of dirs) {
    out[dir] = readJson(join(PACKAGES_DIR, dir, 'package.json')) as PackageManifest;
  }
  return out;
}

describe('checkNpmVersion', () => {
  it('fails for the local npm version (PREMISE: npm --version -> 10.9.8)', () => {
    expect(checkNpmVersion('10.9.8').ok).toBe(false);
  });

  it('fails for a version just below the 11.5.1 floor', () => {
    expect(checkNpmVersion('11.5.0').ok).toBe(false);
  });

  it('passes for exactly 11.5.1', () => {
    expect(checkNpmVersion('11.5.1').ok).toBe(true);
  });

  it('passes for a version above the floor', () => {
    expect(checkNpmVersion('12.0.0').ok).toBe(true);
  });

  it('names npm in the failure message', () => {
    expect(checkNpmVersion('10.9.8').message).toMatch(/npm/i);
  });
});

describe('tgzFilenameFor', () => {
  it('strips the scope and joins with a dash for a scoped package', () => {
    expect(tgzFilenameFor({ name: '@vetkit/spec', version: '0.0.0' })).toBe(
      'vetkit-spec-0.0.0.tgz',
    );
  });

  it('leaves an unscoped package name as-is', () => {
    expect(tgzFilenameFor({ name: 'vetkit', version: '0.0.0' })).toBe('vetkit-0.0.0.tgz');
  });
});

describe('topoSortPackages', () => {
  it('orders a dependency before its dependent', () => {
    const manifests: Record<string, PackageManifest> = {
      b: { name: '@vetkit/b', version: '0.0.0', dependencies: { '@vetkit/a': 'workspace:^' } },
      a: { name: '@vetkit/a', version: '0.0.0' },
    };
    const order = topoSortPackages(manifests);
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'));
  });

  it('ignores non-@vetkit dependencies', () => {
    const manifests: Record<string, PackageManifest> = {
      a: { name: '@vetkit/a', version: '0.0.0', dependencies: { yaml: '^2.9.1' } },
    };
    expect(topoSortPackages(manifests)).toEqual(['a']);
  });

  it('orders spec before core before cli on the real package manifests', () => {
    const order = topoSortPackages(loadRealManifests());
    expect(order.indexOf('spec')).toBeLessThan(order.indexOf('core'));
    expect(order.indexOf('core')).toBeLessThan(order.indexOf('cli'));
  });
});

describe('.changeset/config.json', () => {
  const config = readJson(CHANGESET_CONFIG_PATH) as Record<string, unknown>;

  it('sets access to public', () => {
    expect(config.access).toBe('public');
  });

  it('sets baseBranch to master by name', () => {
    expect(config.baseBranch).toBe('master');
  });

  it('sets updateInternalDependencies to patch', () => {
    expect(config.updateInternalDependencies).toBe('patch');
  });

  it('sets an empty ignore list', () => {
    expect(config.ignore).toEqual([]);
  });
});

describe('root package.json scripts.version', () => {
  const rootPkg = readJson(join(ROOT, 'package.json')) as { scripts?: Record<string, string> };
  const versionScript = rootPkg.scripts?.version ?? '';

  it('runs changeset version', () => {
    expect(versionScript).toMatch(/changeset version/);
  });

  it('runs bun install --no-frozen-lockfile after changeset version', () => {
    const changesetIdx = versionScript.indexOf('changeset version');
    const installIdx = versionScript.indexOf('bun install --no-frozen-lockfile');
    expect(installIdx).toBeGreaterThan(-1);
    expect(installIdx).toBeGreaterThan(changesetIdx);
  });
});

describe('.github/workflows/release.yml', () => {
  const rawText = readFileSync(WORKFLOW_PATH, 'utf8');
  const workflow = parseYaml(rawText) as {
    on?: { push?: { branches?: string[] } };
    jobs: Record<string, any>;
  };

  it('triggers on push to master', () => {
    expect(workflow.on?.push?.branches).toContain('master');
  });

  it('has a version job and a publish job', () => {
    expect(workflow.jobs.version).toBeDefined();
    expect(workflow.jobs.publish).toBeDefined();
  });

  describe('version job', () => {
    const versionJob = workflow.jobs.version;
    const steps: any[] = versionJob.steps;
    const changesetsStep = steps.find((s) => String(s.uses ?? '').startsWith('changesets/action'));

    it('runs changesets/action with version: bun run version', () => {
      expect(changesetsStep).toBeDefined();
      expect(changesetsStep.with.version).toBe('bun run version');
    });

    it('has no publish input', () => {
      expect(changesetsStep.with.publish).toBeUndefined();
    });

    it('exposes hasChangesets as a job output sourced from the changesets step', () => {
      expect(versionJob.outputs?.hasChangesets).toContain('steps.');
      expect(versionJob.outputs?.hasChangesets).toContain('outputs.hasChangesets');
    });
  });

  describe('publish job gating (R1)', () => {
    const publishJob = workflow.jobs.publish;

    it('needs the version job', () => {
      const needs = publishJob.needs;
      expect(Array.isArray(needs) ? needs : [needs]).toContain('version');
    });

    it('only runs when there are no pending changesets, on master', () => {
      expect(publishJob.if).toContain("needs.version.outputs.hasChangesets == 'false'");
      expect(publishJob.if).toContain("github.ref == 'refs/heads/master'");
    });
  });

  describe('publish job permissions and secrets', () => {
    const publishJob = workflow.jobs.publish;

    it('grants id-token: write', () => {
      expect(publishJob.permissions?.['id-token']).toBe('write');
    });

    it('never references NPM_TOKEN or NODE_AUTH_TOKEN', () => {
      expect(rawText).not.toMatch(/NPM_TOKEN/);
      expect(rawText).not.toMatch(/NODE_AUTH_TOKEN/);
    });

    it('installs npm@latest globally', () => {
      expect(rawText).toMatch(/npm i -g npm@latest/);
    });
  });

  describe('publish job step order (R2)', () => {
    const steps: any[] = workflow.jobs.publish.steps;
    const runTexts: string[] = steps.map((s) => String(s.run ?? ''));

    const prePackIdx = runTexts.findIndex(
      (t) => t.includes('release-preflight') && !t.includes('--tarballs'),
    );
    const packIdx = runTexts.findIndex((t) => t.includes('bun run pack'));
    const postPackIdx = runTexts.findIndex(
      (t) => t.includes('release-preflight') && t.includes('--tarballs'),
    );
    const publishIdx = runTexts.findIndex((t) => t.includes('npm publish'));

    it('runs the pre-pack preflight before pack', () => {
      expect(prePackIdx).toBeGreaterThanOrEqual(0);
      expect(packIdx).toBeGreaterThan(prePackIdx);
    });

    it('runs the post-pack preflight after pack and before publish', () => {
      expect(postPackIdx).toBeGreaterThan(packIdx);
      expect(publishIdx).toBeGreaterThan(postPackIdx);
    });
  });

  describe('publish command shape (never bun publish / changeset publish)', () => {
    it('never invokes bun publish or changeset publish', () => {
      expect(rawText).not.toMatch(/\bbun publish\b/);
      expect(rawText).not.toMatch(/\bchangeset publish\b/);
    });

    it('every publish command targets a .tgz path with --provenance --access public', () => {
      const publishStep = workflow.jobs.publish.steps.find((s: any) =>
        String(s.run ?? '').includes('npm publish'),
      );
      expect(publishStep).toBeDefined();
      expect(publishStep.run).toMatch(/npm publish\s+"?[^\s"]*\.tgz"?.*--provenance.*--access public/);
    });

    it('skips a tarball whose version already exists on the registry (R4)', () => {
      const publishStep = workflow.jobs.publish.steps.find((s: any) =>
        String(s.run ?? '').includes('npm publish'),
      );
      expect(publishStep.run).toMatch(/npm view/);
    });
  });
});
