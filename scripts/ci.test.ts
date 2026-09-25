import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW_PATH = join(ROOT, '.github/workflows/ci.yml');
const LEFTHOOK_PATH = join(ROOT, 'lefthook.yml');

const NODE_MATRIX = [22, 24, 26];

function readWorkflow(): { text: string; doc: any } {
  const text = readFileSync(WORKFLOW_PATH, 'utf8');
  return { text, doc: parse(text) };
}

function runStepsOf(job: any): string[] {
  return (job.steps as any[]).filter((step) => typeof step.run === 'string').map((s) => s.run);
}

describe('.github/workflows/ci.yml', () => {
  it('triggers on pull_request and on push to master', () => {
    const { doc } = readWorkflow();
    expect(doc.on).toHaveProperty('pull_request');
    expect(doc.on.push.branches).toEqual(['master']);
  });

  it('check-build-pack runs on ubuntu-latest with a Node 22/24/26 matrix', () => {
    const { doc } = readWorkflow();
    const job = doc.jobs['check-build-pack'];
    expect(job['runs-on']).toBe('ubuntu-latest');
    expect(job.strategy.matrix.node).toEqual(NODE_MATRIX);
  });

  it('check-build-pack pins Bun via oven-sh/setup-bun and sets up Node from the matrix', () => {
    const { doc } = readWorkflow();
    const steps = doc.jobs['check-build-pack'].steps as any[];
    const bunStep = steps.find((s) => typeof s.uses === 'string' && s.uses.startsWith('oven-sh/setup-bun@'));
    expect(bunStep?.with?.['bun-version']).toBe('1.4.2');

    const nodeStep = steps.find((s) => typeof s.uses === 'string' && s.uses.startsWith('actions/setup-node@'));
    expect(nodeStep?.with?.['node-version']).toBe('${{ matrix.node }}');
  });

  it('check-build-pack runs install, codegen-diff, check, build, pack in that order', () => {
    const { doc } = readWorkflow();
    const job = doc.jobs['check-build-pack'];
    expect(runStepsOf(job)).toEqual([
      'bun install --frozen-lockfile',
      'bun run codegen && git diff --exit-code',
      'bun run check',
      'bun run build',
      'bun run pack',
    ]);
  });

  it('check-build-pack uploads dist-tarballs as an artifact', () => {
    const { doc } = readWorkflow();
    const steps = doc.jobs['check-build-pack'].steps as any[];
    const uploadStep = steps.find(
      (s) => typeof s.uses === 'string' && s.uses.startsWith('actions/upload-artifact@'),
    );
    expect(uploadStep?.with?.path).toBe('dist-tarballs');
  });

  it('consumer-matrix needs check-build-pack and runs on a Node 22/24/26 matrix', () => {
    const { doc } = readWorkflow();
    const job = doc.jobs['consumer-matrix'];
    expect(job.needs).toBe('check-build-pack');
    expect(job.strategy.matrix.node).toEqual(NODE_MATRIX);
  });

  it('consumer-matrix downloads dist-tarballs and runs scripts/consumer-matrix.sh', () => {
    const { doc } = readWorkflow();
    const job = doc.jobs['consumer-matrix'];
    const steps = job.steps as any[];
    const downloadStep = steps.find(
      (s) => typeof s.uses === 'string' && s.uses.startsWith('actions/download-artifact@'),
    );
    expect(downloadStep?.with?.path).toBe('dist-tarballs');

    expect(runStepsOf(job)).toContainEqual(expect.stringContaining('scripts/consumer-matrix.sh dist-tarballs'));
  });

  it('never runs `bun test` and never installs @types/bun', () => {
    const { text } = readWorkflow();
    expect(text).not.toMatch(/\bbun test\b/);
    expect(text).not.toContain('@types/bun');
  });

  it('uses setup-bun (not a manual Bun install)', () => {
    const { text } = readWorkflow();
    expect(text).toContain('setup-bun');
  });
});

describe('lefthook.yml', () => {
  function readLefthook(): any {
    return parse(readFileSync(LEFTHOOK_PATH, 'utf8'));
  }

  it('runs oxlint and oxfmt --check on staged files in pre-commit, in parallel', () => {
    const doc = readLefthook();
    expect(doc['pre-commit'].parallel).toBe(true);

    const commands = doc['pre-commit'].commands;
    expect(commands.oxlint.run).toContain('oxlint');
    expect(commands.oxlint.run).toContain('{staged_files}');
    expect(commands.oxfmt.run).toContain('oxfmt --check');
    expect(commands.oxfmt.run).toContain('{staged_files}');
  });

  it('has no commit-msg hook', () => {
    const doc = readLefthook();
    expect(doc['commit-msg']).toBeUndefined();
  });
});

describe('package.json hooks:install script', () => {
  it('runs `lefthook install`', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts['hooks:install']).toBe('lefthook install');
  });
});
