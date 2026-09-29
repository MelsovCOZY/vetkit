import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW_PATH = join(ROOT, '.github/workflows/ci.yml');
const LEFTHOOK_PATH = join(ROOT, 'lefthook.yml');

const NODE_MATRIX = [22, 24, 26];

interface WorkflowStep {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, string>;
}

interface WorkflowJob {
  'runs-on'?: string;
  needs?: string;
  strategy?: { matrix?: { node?: number[] } };
  steps: WorkflowStep[];
}

interface WorkflowDoc {
  on: { pull_request?: null; push?: { branches?: string[] } };
  jobs: Record<string, WorkflowJob>;
}

interface LefthookCommand {
  glob?: string;
  run: string;
}

interface LefthookDoc {
  'pre-commit'?: {
    parallel?: boolean;
    commands?: Record<string, LefthookCommand>;
  };
  'commit-msg'?: unknown;
}

interface PackageJson {
  scripts?: Record<string, string>;
}

function readWorkflowText(): string {
  return readFileSync(WORKFLOW_PATH, 'utf8');
}

function readWorkflowDoc(): WorkflowDoc {
  const doc: WorkflowDoc = parse(readWorkflowText());
  return doc;
}

function readLefthookDoc(): LefthookDoc {
  const doc: LefthookDoc = parse(readFileSync(LEFTHOOK_PATH, 'utf8'));
  return doc;
}

function runStepsOf(job: WorkflowJob): string[] {
  return job.steps.filter((step) => typeof step.run === 'string').map((step) => step.run ?? '');
}

describe('.github/workflows/ci.yml', () => {
  it('triggers on pull_request and on push to master', () => {
    const doc = readWorkflowDoc();
    expect(doc.on).toHaveProperty('pull_request');
    expect(doc.on.push?.branches).toEqual(['master']);
  });

  it('check-build-pack runs on ubuntu-latest with a Node 22/24/26 matrix', () => {
    const job = readWorkflowDoc().jobs['check-build-pack'];
    expect(job?.['runs-on']).toBe('ubuntu-latest');
    expect(job?.strategy?.matrix?.node).toEqual(NODE_MATRIX);
  });

  it('check-build-pack pins Bun via oven-sh/setup-bun and sets up Node from the matrix', () => {
    const steps = readWorkflowDoc().jobs['check-build-pack']?.steps ?? [];
    const bunStep = steps.find((step) => step.uses?.startsWith('oven-sh/setup-bun@'));
    expect(bunStep?.with?.['bun-version']).toBe('1.4.2');

    const nodeStep = steps.find((step) => step.uses?.startsWith('actions/setup-node@'));
    expect(nodeStep?.with?.['node-version']).toBe('${{ matrix.node }}');
  });

  it('check-build-pack runs install, codegen-diff, check, build, pack in that order', () => {
    const job = readWorkflowDoc().jobs['check-build-pack'];
    expect(job && runStepsOf(job)).toEqual([
      'bun install --frozen-lockfile',
      'bun run codegen && git diff --exit-code',
      'bun run check',
      'bun run build',
      'bun run pack',
    ]);
  });

  it('check-build-pack uploads dist-tarballs as an artifact', () => {
    const steps = readWorkflowDoc().jobs['check-build-pack']?.steps ?? [];
    const uploadStep = steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
    expect(uploadStep?.with?.path).toBe('dist-tarballs');
  });

  it('consumer-matrix needs check-build-pack and runs on a Node 22/24/26 matrix', () => {
    const job = readWorkflowDoc().jobs['consumer-matrix'];
    expect(job?.needs).toBe('check-build-pack');
    expect(job?.strategy?.matrix?.node).toEqual(NODE_MATRIX);
  });

  it('consumer-matrix downloads dist-tarballs and runs scripts/consumer-matrix.sh', () => {
    const job = readWorkflowDoc().jobs['consumer-matrix'];
    const steps = job?.steps ?? [];
    const downloadStep = steps.find((step) => step.uses?.startsWith('actions/download-artifact@'));
    expect(downloadStep?.with?.path).toBe('dist-tarballs');

    expect(job && runStepsOf(job)).toContainEqual(
      expect.stringContaining('scripts/consumer-matrix.sh dist-tarballs'),
    );
  });

  it('never runs `bun test` and never installs @types/bun', () => {
    const text = readWorkflowText();
    expect(text).not.toMatch(/\bbun test\b/);
    expect(text).not.toContain('@types/bun');
  });

  it('uses setup-bun (not a manual Bun install)', () => {
    expect(readWorkflowText()).toContain('setup-bun');
  });
});

describe('lefthook.yml', () => {
  it('runs oxlint and oxfmt --check on staged files in pre-commit, in parallel', () => {
    const doc = readLefthookDoc();
    expect(doc['pre-commit']?.parallel).toBe(true);

    const commands = doc['pre-commit']?.commands;
    expect(commands?.oxlint?.run).toContain('oxlint');
    expect(commands?.oxlint?.run).toContain('{staged_files}');
    expect(commands?.oxfmt?.run).toContain('oxfmt --check');
    expect(commands?.oxfmt?.run).toContain('{staged_files}');
  });

  it('has no commit-msg hook', () => {
    expect(readLefthookDoc()['commit-msg']).toBeUndefined();
  });
});

describe('package.json hooks:install script', () => {
  it('runs the lefthook install script', () => {
    const pkg: PackageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts?.['hooks:install']).toBe('bun scripts/install-hooks.ts');
  });
});
