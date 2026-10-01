import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOWS_DIR = join(ROOT, '.github', 'workflows');

interface WorkflowFile {
  name: string;
  text: string;
}

function readWorkflowFiles(): WorkflowFile[] {
  return readdirSync(WORKFLOWS_DIR)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .map((name) => ({ name, text: readFileSync(join(WORKFLOWS_DIR, name), 'utf8') }));
}

describe('pr-title.yml conventional-commit regex', () => {
  const prTitleText = readFileSync(join(WORKFLOWS_DIR, 'pr-title.yml'), 'utf8');
  // Read the SAME regex the workflow's bash conditional embeds, so the test and the
  // workflow cannot drift apart.
  const match = prTitleText.match(/regex='([^']+)'/);
  if (!match) {
    throw new Error("pr-title.yml must define regex='...' for the test to read");
  }
  const titleRegex = new RegExp(match[1] ?? '');

  it.each([
    'feat: add pkg-pr-new preview workflow',
    'fix(cli): handle missing config file',
    'docs: update README with pkg-pr-new instructions',
  ])('accepts conventional commit title "%s"', (title) => {
    expect(titleRegex.test(title)).toBe(true);
  });

  it.each([
    'Update the pr-title workflow',
    'feature: broaden the allowed types',
    'fix:add missing space after colon',
  ])('rejects non-conventional-commit title "%s"', (title) => {
    expect(titleRegex.test(title)).toBe(false);
  });

  // The Version Packages PR is opened by changesets/action, so its title must pass this same check
  // or the release chain stalls on the first PR it opens.
  it('accepts the title and commit release.yml gives changesets/action for the Version Packages PR', () => {
    const release = parseYaml(readFileSync(join(WORKFLOWS_DIR, 'release.yml'), 'utf8'));
    const steps = Object.values<{ steps?: { uses?: string; with?: Record<string, string> }[] }>(
      release.jobs,
    ).flatMap((job) => job.steps ?? []);
    const changesets = steps.find((step) => step.uses?.startsWith('changesets/action@') === true);
    expect(changesets).toBeDefined();
    const title = changesets?.with?.['title'];
    const commit = changesets?.with?.['commit'];
    expect(title).toBeDefined();
    expect(titleRegex.test(title ?? '')).toBe(true);
    expect(commit).toBeDefined();
    expect(titleRegex.test(commit ?? '')).toBe(true);
  });
});

describe('pkg-pr-new.yml step order', () => {
  const doc = parseYaml(readFileSync(join(WORKFLOWS_DIR, 'pkg-pr-new.yml'), 'utf8'));
  const steps = Object.values<{ steps?: { run?: unknown }[] }>(doc.jobs).flatMap(
    (job) => job.steps ?? [],
  );
  const runs = steps
    .map((step) => step.run)
    .filter((run): run is string => typeof run === 'string');

  const buildIndex = runs.findIndex((run) => run.includes('bun run build'));
  const packIndex = runs.findIndex((run) => run.includes('bun run pack'));
  const publishIndex = runs.findIndex((run) => /pkg-pr-new(@\S+)? publish/.test(run));

  it('runs build before pack (publint inside pack checks the dist/ files)', () => {
    expect(buildIndex).toBeGreaterThanOrEqual(0);
    expect(packIndex).toBeGreaterThan(buildIndex);
  });

  it('runs pack before publishing previews', () => {
    expect(packIndex).toBeGreaterThanOrEqual(0);
    expect(publishIndex).toBeGreaterThan(packIndex);
  });

  it('publishes the packed tarball glob', () => {
    expect(runs[publishIndex]).toMatch(/dist-tarballs\/\*\.tgz/);
  });
});

interface RenovateRule {
  groupName?: string;
  matchDepTypes?: string[];
  matchPackageNames?: string[];
  matchPackagePatterns?: string[];
  rangeStrategy?: string;
  dependencyDashboardApproval?: boolean;
}

describe('renovate.json', () => {
  const renovate = JSON.parse(readFileSync(join(ROOT, 'renovate.json'), 'utf8'));
  const rules: RenovateRule[] = renovate.packageRules ?? [];

  it('groups oxlint and oxfmt into one PR', () => {
    const rule = rules.find(
      (r) =>
        Array.isArray(r.matchPackageNames) &&
        r.matchPackageNames.includes('oxlint') &&
        r.matchPackageNames.includes('oxfmt'),
    );
    expect(rule).toBeDefined();
    expect(typeof rule?.groupName).toBe('string');
  });

  it('groups all @opentelemetry/* packages into one PR', () => {
    const rule = rules.find((r) => {
      const patterns = [...(r.matchPackagePatterns ?? []), ...(r.matchPackageNames ?? [])];
      return (
        typeof r.groupName === 'string' &&
        patterns.some((p: string) =>
          new RegExp(p.replace(/^\/|\/$/g, '')).test('@opentelemetry/api'),
        )
      );
    });
    expect(rule).toBeDefined();
  });

  it('pins devDependencies exactly (rangeStrategy: pin)', () => {
    const rule = rules.find(
      (r) => Array.isArray(r.matchDepTypes) && r.matchDepTypes.includes('devDependencies'),
    );
    expect(rule?.rangeStrategy).toBe('pin');
  });

  it('marks evalite and @typesafe-ai/sdk as manual dependencyDashboardApproval', () => {
    const rule = rules.find(
      (r) =>
        Array.isArray(r.matchPackageNames) &&
        r.matchPackageNames.includes('evalite') &&
        r.matchPackageNames.includes('@typesafe-ai/sdk'),
    );
    expect(rule?.dependencyDashboardApproval).toBe(true);
  });

  it('schedules dependency updates weekly', () => {
    const extendsList: string[] = renovate.extends ?? [];
    const schedule: string[] = renovate.schedule ?? [];
    const isWeekly =
      extendsList.some((e) => e.includes('weekly')) || schedule.some((s) => /week|monday/i.test(s));
    expect(isWeekly).toBe(true);
  });
});

describe('pull_request_target supply-chain guard', () => {
  it('never combines pull_request_target with a checkout of the PR head, in any workflow file', () => {
    const files = readWorkflowFiles();
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const usesPullRequestTarget = /\bpull_request_target\b/.test(file.text);
      const checksOutPrHead = /ref:\s*.*github\.event\.pull_request\.head/.test(file.text);
      expect(
        usesPullRequestTarget && checksOutPrHead,
        `${file.name} must not combine pull_request_target with a PR-head checkout`,
      ).toBe(false);
    }
  });
});
