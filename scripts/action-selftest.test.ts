import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEXT = readFileSync(join(ROOT, '.github/workflows/action-selftest.yml'), 'utf8');

interface Step {
  id?: string;
  name?: string;
  if?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
}

interface Job {
  needs?: string;
  strategy?: { matrix?: { include?: Record<string, string>[] } };
  steps: Step[];
}

interface Doc {
  on: Record<string, unknown>;
  jobs: Record<string, Job>;
}

const doc: Doc = parse(TEXT);
const selftest = doc.jobs['selftest'] as Job;
const baselineJob = doc.jobs['baseline-key'];

function step(job: Job, fragment: string): Step {
  const found = job.steps.find((s) => s.name?.includes(fragment));
  if (found === undefined) throw new Error(`no step named like "${fragment}"`);
  return found;
}

const allSteps = Object.values(doc.jobs).flatMap((job) => job.steps);

describe('.github/workflows/action-selftest.yml', () => {
  it('the selftest matrix posts comments with distinct comment-id values for pass and fail', () => {
    const entries = selftest.strategy?.matrix?.include ?? [];
    const commenting = entries.filter((e) => e['comment'] === 'true').map((e) => e['name']);
    expect(commenting).toEqual(expect.arrayContaining(['pass', 'fail']));
    expect(commenting).not.toContain('gate-refused');
    expect(step(selftest, 'Run the action').with?.['comment-id']).toBe('${{ matrix.name }}');
  });

  it('the selftest asserts the PR comment headline, the uncalibrated banner, the pinned line and the run link via gh api', () => {
    const assertStep = step(selftest, 'Assert the PR comment');
    const script = assertStep.run ?? '';
    expect(script).toContain('gh api');
    expect(script).toContain('### vetkit: passed');
    expect(script).toContain('### vetkit: failed');
    expect(script).toContain('thresholds uncalibrated: run vet validate');
    expect(script).toContain('pinned: false —');
    expect(script).toContain('actions/runs/');
    expect(script).toMatch(/MATRIX_NAME/);
    expect(assertStep.env?.['MATRIX_NAME']).toBe('${{ matrix.name }}');
    expect(assertStep.env?.['PR_NUMBER']).toBe('${{ github.event.pull_request.number }}');
    expect(assertStep.if).toContain('github.event.pull_request.head.repo.fork');
  });

  it('the selftest runs vet directly and asserts ::error on stderr in fail mode and none in pass mode', () => {
    const script = step(selftest, 'Assert annotations and summary').run ?? '';
    expect(script).toMatch(/\bvet run\b/);
    expect(script).toContain('::error');
    expect(script).toMatch(/2>\s*\S*stderr/);
    expect(script).toMatch(/MODE.*fail|fail.*MODE/s);
  });

  it('the selftest reads GITHUB_STEP_SUMMARY in the same step and asserts it is non-empty and key-free', () => {
    const script = step(selftest, 'Assert annotations and summary').run ?? '';
    expect(script).toContain('GITHUB_STEP_SUMMARY');
    expect(script).toMatch(/-s\s+"?\$GITHUB_STEP_SUMMARY/);
    expect(script).toContain('VETKIT_FIXTURE_KEY');
    // Each step has its own summary file, so no other step may read it.
    const readers = allSteps.filter((s) => (s.run ?? '').includes('GITHUB_STEP_SUMMARY'));
    expect(readers).toHaveLength(1);
  });

  it('a baseline-key job runs the action three times and asserts the key changes after a case edit and after a config edit', () => {
    expect(baselineJob?.needs).toBe('pack');
    const actionSteps = (baselineJob?.steps ?? []).filter((s) => s.uses === './');
    expect(actionSteps.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    for (const s of actionSteps) expect(s.with?.['comment']).toBe('false');
    const text = (baselineJob?.steps ?? []).map((s) => s.run ?? '').join('\n');
    expect(text).toContain('cases.jsonl');
    expect(text).toContain('vetkit.config.ts');
    const check = step(baselineJob as Job, 'Assert the baseline key');
    expect(check.env?.['KEY_A']).toBe('${{ steps.a.outputs.baseline-key }}');
    expect(check.env?.['KEY_B']).toBe('${{ steps.b.outputs.baseline-key }}');
    expect(check.env?.['KEY_C']).toBe('${{ steps.c.outputs.baseline-key }}');
    expect(check.run).toMatch(/KEY_A.*KEY_B/s);
    expect(check.run).toMatch(/KEY_B.*KEY_C/s);
  });

  it('every step reads github.event.* only through env', () => {
    for (const s of allSteps) {
      expect(s.run ?? '', s.name).not.toMatch(/\$\{\{\s*github\.event\./);
      expect(s.run ?? '', s.name).not.toMatch(/\$\{\{\s*inputs\./);
    }
  });

  it('never triggers on pull_request_target', () => {
    expect(Object.keys(doc.on)).not.toContain('pull_request_target');
    expect(TEXT).not.toContain('pull_request_target');
  });
});
