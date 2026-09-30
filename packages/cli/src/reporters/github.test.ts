import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunVerdict } from '@vetkit/core';
import { safeParseJson } from '@vetkit/spec';
import { beforeAll, describe, expect, test } from 'vitest';
import { ensureCliBuilt } from '../test-support/build-cli.js';
import { renderAnnotations, writeGithubSummary } from './github.ts';

const binPath = fileURLToPath(new URL('../../dist/bin.js', import.meta.url));
const fixtureDir = fileURLToPath(new URL('../../../../fixtures/cli/run', import.meta.url));
const SECRET = 'sk-fixture-do-not-print-7f3a';

beforeAll(async () => {
  await ensureCliBuilt();
}, 180_000);

function verdict(caseId: string, status: string, pass?: boolean): RunVerdict {
  // The verdict is a plain fixture; only the fields the renderer reads matter.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return {
    caseId,
    criterionId: 'tone',
    status,
    ...(pass === undefined ? {} : { pass }),
    ...(status === 'ok'
      ? {
          answer: {
            type: 'boolean',
            probability: 0.1,
            confidence: 0.9,
          },
        }
      : {}),
    threshold: 0.5,
  } as unknown as RunVerdict;
}

function result(results: RunVerdict[], aborted = false): Parameters<typeof renderAnnotations>[0] {
  return { results, summary: { aborted } };
}

const lines = (out: string[]): string[] => out.flatMap((l) => l.split('\n'));

describe('renderAnnotations', () => {
  test('renderAnnotations emits one ::error per scored fail and one ::warning per unscored verdict, title=vetkit', () => {
    const out = renderAnnotations(
      result([
        verdict('c-pass', 'ok', true),
        verdict('c-fail', 'ok', false),
        verdict('c-down', 'unscored'),
        verdict('c-na', 'not_applicable'),
      ]),
      { env: {} },
    );
    const errors = out.filter((l) => l.startsWith('::error '));
    const warnings = out.filter((l) => l.startsWith('::warning '));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^::error title=vetkit::c-fail failed/);
    expect(errors[0]).toContain('tone');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^::warning title=vetkit::c-down /);
    expect(out.join('\n')).not.toContain('c-pass');
    expect(out.join('\n')).not.toContain('c-na');
  });

  test('renderAnnotations caps at 10 errors and 10 warnings and adds one ::notice with the remainder', () => {
    const many = [
      ...Array.from({ length: 13 }, (_, i) => verdict(`f${String(i)}`, 'ok', false)),
      ...Array.from({ length: 12 }, (_, i) => verdict(`u${String(i)}`, 'unscored')),
    ];
    const out = renderAnnotations(result(many), { env: {} });
    expect(out.filter((l) => l.startsWith('::error '))).toHaveLength(10);
    expect(out.filter((l) => l.startsWith('::warning '))).toHaveLength(10);
    const notices = out.filter((l) => l.startsWith('::notice '));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/^::notice title=vetkit::/);
    expect(notices[0]).toContain('3 more error');
    expect(notices[0]).toContain('2 more warning');
  });

  test('renderAnnotations adds a run aborted warning when the run was aborted', () => {
    const out = renderAnnotations(result([verdict('c', 'ok', true)], true), { env: {} });
    expect(out).toContain('::warning title=vetkit::run aborted');
  });

  test('renderAnnotations adds no line for a clean run', () => {
    expect(renderAnnotations(result([verdict('c', 'ok', true)]), { env: {} })).toEqual([]);
  });

  test('renderAnnotations escapes %, CR and LF in messages', () => {
    const out = renderAnnotations(result([verdict('a%b\r\nc::d', 'ok', false)]), { env: {} });
    expect(out).toHaveLength(1);
    const line = out[0] ?? '';
    expect(line).toContain('a%25b%0D%0Ac::d');
    expect(line).not.toMatch(/[\r\n]/);
    expect(lines(out)).toHaveLength(1);
  });

  test('renderAnnotations redacts a seeded key', () => {
    const env = { VETKIT_FIXTURE_KEY: 'seeded-value-9c1d2e' };
    const out = renderAnnotations(
      result([
        verdict('seeded-value-9c1d2e', 'ok', false),
        verdict('has-sk-abcdef123456-inside', 'unscored'),
      ]),
      { env },
    ).join('\n');
    expect(out).not.toContain('seeded-value-9c1d2e');
    expect(out).not.toContain('sk-abcdef123456');
    expect(out).toContain('::error ');
  });
});

describe('writeGithubSummary', () => {
  test('writeGithubSummary appends the Markdown renderer output to GITHUB_STEP_SUMMARY', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'vetkit-gh-')), 'summary.md');
    writeFileSync(file, 'earlier\n');
    await writeGithubSummary({ markdown: '### report\n', env: { GITHUB_STEP_SUMMARY: file } });
    expect(readFileSync(file, 'utf8')).toBe('earlier\n### report\n');
  });

  test('writeGithubSummary truncates above 1 MiB with a _truncated_ line', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'vetkit-gh-')), 'summary.md');
    await writeGithubSummary({
      markdown: 'x'.repeat(2 * 1024 * 1024),
      env: { GITHUB_STEP_SUMMARY: file },
    });
    const written = readFileSync(file);
    expect(written.length).toBeLessThanOrEqual(1024 * 1024);
    expect(written.toString('utf8')).toMatch(/\n_truncated_\n?$/);
  });

  test('writeGithubSummary is a no-op when GITHUB_STEP_SUMMARY is unset', async () => {
    const calls: string[] = [];
    await writeGithubSummary({
      markdown: 'x',
      env: {},
      fs: {
        appendFile: (path) => {
          calls.push(String(path));
          return Promise.resolve();
        },
      },
    });
    expect(calls).toEqual([]);
  });

  test('writeGithubSummary never throws when the summary path is unwritable', async () => {
    await expect(
      writeGithubSummary({
        markdown: 'x',
        env: { GITHUB_STEP_SUMMARY: '/nonexistent-dir-vetkit/summary.md' },
      }),
    ).resolves.toBeUndefined();
  });
});

function nonEmptyLines(text: string): string[] {
  return text.split('\n').filter((line) => line.trim() !== '');
}

function run(env: Record<string, string>, summary: string) {
  const project = mkdtempSync(join(tmpdir(), 'vetkit-gh-run-'));
  cpSync(fixtureDir, project, { recursive: true });
  const base: NodeJS.ProcessEnv = { ...process.env };
  delete base['GITHUB_ACTIONS'];
  delete base['GITHUB_STEP_SUMMARY'];
  return spawnSync(process.execPath, [binPath, 'run', '--json'], {
    cwd: project,
    encoding: 'utf8',
    env: {
      ...base,
      NO_COLOR: '1',
      VETKIT_FIXTURE_MODE: 'fail',
      VETKIT_FIXTURE_KEY: SECRET,
      GITHUB_STEP_SUMMARY: summary,
      ...env,
    },
  });
}

describe('vet run in GitHub Actions', () => {
  test('vet run --json with GITHUB_ACTIONS=true keeps stdout to one JSON document and writes ::error lines to stderr in fail mode', () => {
    const summary = join(mkdtempSync(join(tmpdir(), 'vetkit-gh-sum-')), 'summary.md');
    writeFileSync(summary, '');
    const result = run({ GITHUB_ACTIONS: 'true' }, summary);
    expect(result.status).toBe(1);
    const out = nonEmptyLines(result.stdout);
    expect(out).toHaveLength(1);
    expect(safeParseJson<unknown>(out[0] ?? '', {}).ok).toBe(true);
    expect(result.stdout).not.toMatch(/^::/m);
    expect(
      result.stderr.split('\n').some((l) => l.startsWith('::error title=vetkit::case-1 failed')),
    ).toBe(true);
    const written = readFileSync(summary, 'utf8');
    expect(written).not.toBe('');
    expect(written).not.toContain('VETKIT_FIXTURE_KEY');
    expect(written).not.toContain(SECRET);
  }, 60_000);

  test('vet run without GITHUB_ACTIONS writes no :: lines and no summary', () => {
    const summary = join(mkdtempSync(join(tmpdir(), 'vetkit-gh-sum-')), 'summary.md');
    writeFileSync(summary, '');
    const result = run({}, summary);
    expect(result.stderr.split('\n').some((l) => l.startsWith('::'))).toBe(false);
    expect(readFileSync(summary, 'utf8')).toBe('');
  }, 60_000);
});
