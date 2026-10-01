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
function jobNamed(name: string): Job | undefined {
  return doc.jobs[name];
}

const selftest: Job = jobNamed('selftest') ?? { steps: [] };
const baselineJob: Job = jobNamed('baseline-key') ?? { steps: [] };

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

  // vet run --gate refuses before judging when the fixture has no calibrated lock: exit 2 with no
  // verdict passed or failed and the one case unscored. That contract is the one the row asserts.
  it('the gate-refused row expects exit 2 with nothing passed or failed and one unscored verdict', () => {
    const entries = selftest.strategy?.matrix?.include ?? [];
    const byName = Object.fromEntries(entries.map((e) => [e['name'], e]));
    expect(byName['gate-refused']).toMatchObject({
      gate: 'true',
      'expect-exit': '2',
      'expect-passed': '0',
      'expect-failed': '0',
      'expect-unscored': '1',
    });
    expect(byName['pass']).toMatchObject({ 'expect-unscored': '0' });
    expect(byName['fail']).toMatchObject({ 'expect-unscored': '0' });
  });

  it("the assert step compares unscored with the row's expect-unscored instead of a fixed 0", () => {
    const assertStep = step(selftest, 'Assert outputs');
    expect(assertStep.env?.['EXPECT_UNSCORED']).toBe('${{ matrix.expect-unscored }}');
    const script = assertStep.run ?? '';
    expect(script).toContain('[ "$UNSCORED" = "$EXPECT_UNSCORED" ]');
    expect(script).not.toContain('[ "$UNSCORED" = "0" ]');
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
    expect(baselineJob.needs).toBe('pack');
    const actionSteps = baselineJob.steps.filter((s) => s.uses === './');
    expect(actionSteps.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    for (const s of actionSteps) expect(s.with?.['comment']).toBe('false');
    const text = baselineJob.steps.map((s) => s.run ?? '').join('\n');
    expect(text).toContain('cases.jsonl');
    expect(text).toContain('vetkit.config.ts');
    const check = step(baselineJob, 'Assert the baseline key');
    expect(check.env?.['KEY_A']).toBe('${{ steps.a.outputs.baseline-key }}');
    expect(check.env?.['KEY_B']).toBe('${{ steps.b.outputs.baseline-key }}');
    expect(check.env?.['KEY_C']).toBe('${{ steps.c.outputs.baseline-key }}');
    expect(check.run).toMatch(/KEY_A.*KEY_B/s);
    expect(check.run).toMatch(/KEY_B.*KEY_C/s);
  });

  describe('the badge', () => {
    const names = selftest.steps.map((s) => s.name ?? '');
    const runIndex = names.findIndex((n) => n.includes('Run the action'));
    const badgeIndex = names.findIndex((n) => n.includes('Assert the badge'));
    const badgeStep = selftest.steps[badgeIndex];
    const script = badgeStep?.run ?? '';
    const artifactName = selftest.steps[runIndex]?.with?.['artifact-name'];
    // vet writes the badge next to the config the action runs with, not at the workspace root.
    const config = selftest.steps[runIndex]?.with?.['config'] ?? '';
    const vetDir = `${dirname(config)}/.vet`;
    const downloadIndex = selftest.steps.findIndex(
      (s) =>
        s.uses?.startsWith('actions/download-artifact@') === true &&
        s.with?.['name'] === artifactName,
    );

    it("the selftest asserts badge.json exists next to the action's config and is a shields endpoint badge", () => {
      expect(vetDir).toBe('fixtures/cli/run/.vet');
      expect(badgeStep?.env?.['VET_DIR']).toBe(vetDir);
      expect(script).toMatch(/-s\s+"\$VET_DIR\/badge\.json"/);
      expect(script).not.toMatch(/\s\.vet\/badge\.json/);
      expect(script).toContain(
        `jq -e '.schemaVersion == 1 and .label == "vetkit" and (.message|type=="string") and (.color|type=="string")'`,
      );
    });

    it('the selftest rejects a pass rate in the badge message', () => {
      // The calibrated count ("2/3 calibrated") is the one ratio a badge may show; it is
      // stripped before the message is searched.
      expect(script).toContain('gsub("[0-9]+/[0-9]+ calibrated"; "")');
      const pattern = /grep -Eq '([^']+)'/.exec(script)?.[1];
      expect(pattern).toBeDefined();
      const rate = new RegExp(pattern ?? '(?!)');
      for (const message of ['3/4', '3 / 4 pass', '75%', '3 of 4 passed']) {
        expect(message, message).toMatch(rate);
      }
      for (const message of [
        'uncalibrated · pass',
        ' · gate pass',
        'uncalibrated · gate refused',
      ]) {
        expect(message, message).not.toMatch(rate);
      }
    });

    it('the selftest downloads the artifact the action uploaded and asserts it holds the same badge.json', () => {
      expect(artifactName).toBe('vet-junit-${{ matrix.name }}');
      expect(downloadIndex).toBeGreaterThan(runIndex);
      const dir = selftest.steps[downloadIndex]?.with?.['path'] ?? '';
      expect(dir).not.toBe('');
      expect(script).toContain(`cmp -s "$VET_DIR/badge.json" "${dir}/$VET_DIR/badge.json"`);
    });

    it('the badge is asserted after the download and before vet runs again', () => {
      const rerunIndex = names.findIndex((n) => n.includes('Assert annotations and summary'));
      expect(badgeIndex).toBeGreaterThan(downloadIndex);
      expect(downloadIndex).toBeGreaterThan(-1);
      expect(badgeIndex).toBeLessThan(rerunIndex);
    });
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
