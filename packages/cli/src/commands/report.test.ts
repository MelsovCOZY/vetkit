import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeParseJson } from '@vetkit/spec';
import { beforeAll, describe, expect, test } from 'vitest';
import { ensureCliBuilt } from '../test-support/build-cli.js';

const binPath = fileURLToPath(new URL('../../dist/bin.js', import.meta.url));
const fixtureDir = fileURLToPath(new URL('../../../../fixtures/cli/run', import.meta.url));
const SECRET = 'sk-fixture-do-not-print-7f3a';

beforeAll(async () => {
  await ensureCliBuilt();
}, 180_000);

interface Result {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number | null;
}

function freshProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vetkit-report-cmd-'));
  cpSync(fixtureDir, dir, { recursive: true });
  return dir;
}

function env(mode = 'fail'): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NO_COLOR: '1',
    VETKIT_FIXTURE_MODE: mode,
    VETKIT_FIXTURE_KEY: SECRET,
  };
}

function vet(args: readonly string[], cwd: string, mode = 'fail'): Result {
  return spawnSync(process.execPath, [binPath, ...args], { cwd, env: env(mode), encoding: 'utf8' });
}

// A project that already ran once, so a record exists.
function ranProject(mode = 'fail'): string {
  const project = freshProject();
  vet(['run', '--json'], project, mode);
  return project;
}

function parseObject(text: string): Record<string, unknown> {
  const result = safeParseJson<Record<string, unknown>>(text, { type: 'object' });
  if (!result.ok) throw result.error;
  return result.value;
}

describe('vet report', () => {
  test('vet report writes .vet/report.md and .vet/report.html and exits 0 after a failed run', () => {
    const project = freshProject();
    expect(vet(['run', '--json'], project).status).toBe(1);
    const result = vet(['report'], project);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('report: .vet/report.md');
    expect(result.stdout).toContain('report: .vet/report.html');
    expect(readFileSync(join(project, '.vet', 'report.md'), 'utf8')).toMatch(
      /^### vetkit eval report/,
    );
    expect(readFileSync(join(project, '.vet', 'report.html'), 'utf8')).toMatch(/^<!doctype html>/);
  });

  test('does not judge: a report needs no judge run and never rewrites the badge', () => {
    const project = ranProject();
    const badge = join(project, '.vet', 'badge.json');
    const before = readFileSync(badge, 'utf8');
    rmSync(badge);
    // Fixture mode `down` would make a re-judge unscored; the report is unaffected.
    expect(vet(['report'], project, 'down').status).toBe(0);
    expect(existsSync(badge)).toBe(false);
    expect(before).toContain('uncalibrated · fail');
  });

  test('--json prints {md, html} absolute paths', () => {
    const project = ranProject();
    const result = vet(['report', '--json'], project);
    expect(result.status).toBe(0);
    const doc = parseObject(result.stdout);
    expect(Object.keys(doc).toSorted()).toEqual(['html', 'md']);
    expect(String(doc['md'])).toMatch(/report\.md$/);
    expect(String(doc['md']).startsWith('/')).toBe(true);
    expect(existsSync(String(doc['html']))).toBe(true);
  });

  test("--stdout prints Markdown starting with '### vetkit eval report' and writes no file", () => {
    const project = ranProject();
    const result = vet(['report', '--stdout'], project);
    expect(result.status).toBe(0);
    expect(result.stdout.startsWith('### vetkit eval report')).toBe(true);
    expect(existsSync(join(project, '.vet', 'report.md'))).toBe(false);
    expect(existsSync(join(project, '.vet', 'report.html'))).toBe(false);
    // With --json the Markdown still wins.
    expect(vet(['report', '--stdout', '--json'], project).stdout.startsWith('### vetkit')).toBe(
      true,
    );
  });

  test('--md/--html custom paths are honoured and directories created', () => {
    const project = ranProject();
    const result = vet(['report', '--md', 'out/a/r.md', '--html', 'out/b/r.html'], project);
    expect(result.status).toBe(0);
    expect(existsSync(join(project, 'out', 'a', 'r.md'))).toBe(true);
    expect(existsSync(join(project, 'out', 'b', 'r.html'))).toBe(true);
    expect(existsSync(join(project, '.vet', 'report.md'))).toBe(false);
  });

  test('--include-cases adds the case text; default omits it', () => {
    const project = ranProject();
    vet(['report'], project);
    expect(readFileSync(join(project, '.vet', 'report.md'), 'utf8')).not.toContain(
      'Hello! How can I help?',
    );
    vet(['report', '--include-cases'], project);
    expect(readFileSync(join(project, '.vet', 'report.md'), 'utf8')).toContain(
      'Hello! How can I help?',
    );
    expect(readFileSync(join(project, '.vet', 'report.html'), 'utf8')).toContain(
      'Hello! How can I help?',
    );
  });

  test('the fixture secret is absent from both files', () => {
    const project = ranProject();
    vet(['report', '--include-cases'], project);
    for (const file of ['report.md', 'report.html']) {
      expect(readFileSync(join(project, '.vet', file), 'utf8')).not.toContain(SECRET);
    }
  });

  test('no record → exit 2 and stderr contains "run `vet run` first"', () => {
    const result = vet(['report'], freshProject());
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('RUN_NOT_FOUND');
    expect(result.stderr).toContain('run `vet run` first');
  });

  test('--include-cases with the cases dir gone → exit 2 CASE_INVALID', () => {
    const project = ranProject();
    rmSync(join(project, 'evals', 'cases'), { recursive: true });
    const result = vet(['report', '--include-cases'], project);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('CASE_INVALID');
    expect(vet(['report'], project).status).toBe(0);
  });

  test('a record written by an older vetkit → exit 2 E_SCHEMA_INVALID naming vet run', () => {
    const project = freshProject();
    mkdirSync(join(project, '.vet', 'runs'), { recursive: true });
    cpSync(
      fileURLToPath(new URL('../../../../fixtures/reporters/run.json', import.meta.url)),
      join(project, '.vet', 'runs', 'latest.json'),
    );
    const result = vet(['report'], project);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('E_SCHEMA_INVALID');
    expect(result.stderr).toContain('vet run');
  });

  test("--config from another cwd finds the record under that config's cacheDir", () => {
    const project = ranProject();
    const elsewhere = mkdtempSync(join(tmpdir(), 'vetkit-elsewhere-'));
    const result = vet(['report', '--config', join(project, 'vetkit.config.ts')], elsewhere);
    expect(result.status).toBe(0);
    expect(existsSync(join(elsewhere, '.vet', 'report.md'))).toBe(true);
  });

  test('--help lists report', () => {
    const top = vet(['--help'], freshProject());
    expect(top.stdout).toMatch(/^\s+report\b/m);
    const help = vet(['report', '--help'], freshProject());
    for (const flag of ['--config', '--md', '--html', '--include-cases', '--stdout']) {
      expect(help.stdout).toContain(flag);
    }
  });
});
