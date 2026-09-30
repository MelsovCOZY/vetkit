import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
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

interface WorkflowStep {
  name?: string;
  uses?: string;
  id?: string;
  run?: string;
  with?: Record<string, string | number>;
  env?: Record<string, string>;
}

interface WorkflowJob {
  needs?: string | string[];
  if?: string;
  permissions?: Record<string, string>;
  outputs?: Record<string, string>;
  steps: WorkflowStep[];
}

interface Workflow {
  on?: { push?: { branches?: string[] } };
  jobs: Record<string, WorkflowJob>;
}

interface ChangesetConfig {
  access?: string;
  baseBranch?: string;
  updateInternalDependencies?: string;
  ignore?: string[];
}

interface RootPackageJson {
  scripts?: Record<string, string>;
}

function readPackageManifest(path: string): PackageManifest {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function loadWorkflow(path: string): Workflow {
  return parseYaml(readFileSync(path, 'utf8'));
}

function loadChangesetConfig(path: string): ChangesetConfig {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function loadRootPackageJson(path: string): RootPackageJson {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function loadRealManifests(): Record<string, PackageManifest> {
  const dirs = readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  const out: Record<string, PackageManifest> = {};
  for (const dir of dirs) {
    out[dir] = readPackageManifest(join(PACKAGES_DIR, dir, 'package.json'));
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
  const config = loadChangesetConfig(CHANGESET_CONFIG_PATH);

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
  const rootPkg = loadRootPackageJson(join(ROOT, 'package.json'));
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
  const workflow = loadWorkflow(WORKFLOW_PATH);

  it('triggers on push to master', () => {
    expect(workflow.on?.push?.branches).toContain('master');
  });

  it('has a version job and a publish job', () => {
    expect(workflow.jobs.version).toBeDefined();
    expect(workflow.jobs.publish).toBeDefined();
  });

  describe('version job', () => {
    const versionJob = workflow.jobs.version;
    const changesetsStep = versionJob?.steps.find((s) =>
      (s.uses ?? '').startsWith('changesets/action'),
    );

    it('runs changesets/action with version: bun run version', () => {
      expect(changesetsStep).toBeDefined();
      expect(changesetsStep?.with?.version).toBe('bun run version');
    });

    it('has no publish input', () => {
      expect(changesetsStep?.with?.publish).toBeUndefined();
    });

    it('exposes hasChangesets as a job output sourced from the changesets step', () => {
      expect(versionJob?.outputs?.hasChangesets).toContain('steps.');
      expect(versionJob?.outputs?.hasChangesets).toContain('outputs.hasChangesets');
    });
  });

  describe('publish job gating (R1)', () => {
    const publishJob = workflow.jobs.publish;

    it('needs the version job', () => {
      const needs = publishJob?.needs;
      expect(Array.isArray(needs) ? needs : [needs]).toContain('version');
    });

    it('only runs when there are no pending changesets, on master', () => {
      expect(publishJob?.if).toContain("needs.version.outputs.hasChangesets == 'false'");
      expect(publishJob?.if).toContain("github.ref == 'refs/heads/master'");
    });
  });

  describe('publish job permissions and secrets', () => {
    const publishJob = workflow.jobs.publish;

    it('grants id-token: write', () => {
      expect(publishJob?.permissions?.['id-token']).toBe('write');
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
    const steps = workflow.jobs.publish?.steps ?? [];
    const runTexts: string[] = steps.map((s) => s.run ?? '');

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
    const publishStep = workflow.jobs.publish?.steps.find((s) =>
      (s.run ?? '').includes('npm publish'),
    );

    it('never invokes bun publish or changeset publish', () => {
      expect(rawText).not.toMatch(/\bbun publish\b/);
      expect(rawText).not.toMatch(/\bchangeset publish\b/);
    });

    it('every publish command targets a tarball path under dist-tarballs with --provenance --access public', () => {
      expect(publishStep).toBeDefined();
      expect(publishStep?.run).toMatch(
        /npm publish\s+"\$\{?tgzPath\}?"\s+--provenance\s+--access public/,
      );
      expect(publishStep?.run).toMatch(/dist-tarballs/);
    });

    it('skips a tarball whose version already exists on the registry (R4)', () => {
      expect(publishStep?.run).toMatch(/npm view/);
    });
  });
});

describe('.github/workflows/release.yml release check and tags', () => {
  const rawText = readFileSync(WORKFLOW_PATH, 'utf8');
  const workflow = loadWorkflow(WORKFLOW_PATH);
  const publishSteps = workflow.jobs.publish?.steps ?? [];
  const tagJob = workflow.jobs['action-tag'];
  const tagRuns = (tagJob?.steps ?? []).map((s) => s.run ?? '');
  const tagStepIdx = tagRuns.findIndex((t) => t.includes('changeset git-tag'));

  it('runs the release check between the post-pack preflight and publish', () => {
    const runs = publishSteps.map((s) => s.run ?? '');
    const postPackIdx = runs.findIndex(
      (t) => t.includes('release-preflight') && t.includes('--tarballs'),
    );
    const checkIdx = runs.findIndex(
      (t) => t.trim() === 'bun scripts/release-check.ts dist-tarballs',
    );
    const publishIdx = runs.findIndex((t) => t.includes('npm publish'));
    expect(checkIdx).toBeGreaterThan(postPackIdx);
    expect(publishIdx).toBeGreaterThan(checkIdx);
  });

  it('tags every package after publish with changeset git-tag and pushes tags', () => {
    expect(tagJob).toBeDefined();
    expect(tagStepIdx).toBeGreaterThanOrEqual(0);
    const step = tagRuns[tagStepIdx] ?? '';
    expect(step).toMatch(/bunx changeset git-tag/);
    expect(step).toMatch(/git push origin --tags/);
    expect(step).toMatch(/git tag -l/);
    expect(step).toMatch(/git config user\.name/);
    expect(step).toMatch(/git config user\.email/);
    const checkout = tagJob?.steps.find((s) => (s.uses ?? '').startsWith('actions/checkout@'));
    expect(checkout?.with?.['fetch-depth']).toBe(0);
  });

  it('publish job stays read-only for contents and the action-tag job grants contents: write for tags', () => {
    expect(workflow.jobs.publish?.permissions?.contents).toBe('read');
    expect(workflow.jobs.publish?.permissions?.['id-token']).toBe('write');
    expect(tagJob?.permissions?.contents).toBe('write');
  });

  it('never creates a v-prefixed tag in the package-tag step', () => {
    const step = tagRuns[tagStepIdx] ?? '';
    expect(step).not.toMatch(/git tag\s+(-f\s+)?"?v/);
    expect(step).not.toMatch(/refs\/tags\/v/);
    expect(rawText).not.toMatch(/\bchangeset tag\b/);
  });

  it('keeps the publish gate on vars.RELEASE_PUBLISH unchanged', () => {
    expect(workflow.jobs.publish?.if).toContain("vars.RELEASE_PUBLISH == 'true'");
  });
});

describe('.github/workflows/release.yml action-tag job', () => {
  const rawText = readFileSync(WORKFLOW_PATH, 'utf8');
  const job = loadWorkflow(WORKFLOW_PATH).jobs['action-tag'];
  const runs = (job?.steps ?? []).map((s) => s.run ?? '').join('\n');

  it('needs publish and runs only when publish succeeded', () => {
    const needs = job?.needs;
    expect(Array.isArray(needs) ? needs : [needs]).toContain('publish');
    expect(job?.if).toContain('needs.publish.result == ');
    expect(job?.if).toContain("'success'");
  });

  it('has contents: write and no other write permission', () => {
    const writes = Object.entries(job?.permissions ?? {}).filter(([, v]) => v === 'write');
    expect(writes).toEqual([['contents', 'write']]);
  });

  it('creates the release vX.Y.Z from packages/cli/package.json version idempotently', () => {
    expect(runs).toContain('packages/cli/package.json');
    expect(runs).toMatch(/gh release view "v\$\{?VERSION\}?"/);
    expect(runs).toMatch(/gh release create "v\$\{?VERSION\}?"/);
    expect(runs.indexOf('gh release view')).toBeLessThan(runs.indexOf('gh release create'));
    expect(runs).toMatch(/\|\|\s*gh release create/);
  });

  it('force-moves the plain major tag', () => {
    expect(runs).toMatch(/MAJOR="?\$\{VERSION%%\.\*\}"?/);
    expect(runs).toMatch(/git tag -f "v\$\{?MAJOR\}?"/);
    expect(runs).toMatch(/git push --force origin "refs\/tags\/v\$\{?MAJOR\}?"/);
    expect(runs).not.toMatch(/refs\/tags\/v1\b/);
    expect(rawText).not.toMatch(/@v1\b/);
  });

  it('never creates a tag in the changesets namespace', () => {
    const tagLines = runs
      .split('\n')
      .filter((l) => /git tag|git push/.test(l) && !/changeset git-tag/.test(l));
    for (const line of tagLines) expect(line).not.toContain('vetkit@');
    expect(runs).not.toMatch(/gh release create "vetkit@/);
    expect(runs).not.toMatch(/gh release create "v\$\{?MAJOR\}?"/);
  });

  it('passes values through env, never a github expression inside run', () => {
    expect(runs).not.toMatch(/\$\{\{/);
    const env = (job?.steps ?? []).find((s) => (s.run ?? '').includes('gh release'))?.env;
    expect(env?.['GH_TOKEN']).toBe('${{ github.token }}');
  });

  it('tags packages before the release and the major tag', () => {
    const idx = (job?.steps ?? []).map((s) => s.run ?? '');
    const gitTag = idx.findIndex((t) => t.includes('changeset git-tag'));
    const release = idx.findIndex((t) => t.includes('gh release'));
    const major = idx.findIndex((t) => t.includes('git tag -f'));
    expect(gitTag).toBeGreaterThanOrEqual(0);
    expect(release).toBeGreaterThan(gitTag);
    expect(major).toBeGreaterThanOrEqual(release);
  });
});

describe('.changeset entries', () => {
  it('the initial changeset lists every package under packages/* as minor', () => {
    const text = readFileSync(join(ROOT, '.changeset/initial-release.md'), 'utf8');
    const front = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? '';
    const entries = parseYaml(front) as Record<string, string>;
    const names = readdirSync(PACKAGES_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => JSON.parse(readFileSync(join(PACKAGES_DIR, d.name, 'package.json'), 'utf8')).name)
      .toSorted();
    expect(Object.keys(entries).toSorted()).toEqual(names);
    expect(new Set(Object.values(entries))).toEqual(new Set(['minor']));
    expect(names).toHaveLength(12);
  });
});
