import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

// A private copy of the fixture project per test, so the verdict cache never leaks
// between modes and nothing is written under fixtures/.
function freshProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vetkit-run-'));
  cpSync(fixtureDir, dir, { recursive: true });
  return dir;
}

function fixtureEnv(mode: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NO_COLOR: '1',
    VETKIT_FIXTURE_MODE: mode,
    VETKIT_FIXTURE_KEY: SECRET,
    ...extra,
  };
}

function runVet(args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Result {
  return spawnSync(process.execPath, [binPath, ...args], { cwd, env, encoding: 'utf8' });
}

function parseJson(text: string): unknown {
  const result = safeParseJson<unknown>(text, {});
  if (!result.ok) throw result.error;
  return result.value;
}

function nonEmptyLines(text: string): string[] {
  return text.split('\n').filter((line) => line.trim() !== '');
}

describe('vet run', () => {
  test('--json prints exactly one JSON document {results, summary, model}; stderr only log lines', () => {
    const result = runVet(['run', '--json'], freshProject(), fixtureEnv('pass'));
    expect(result.status).toBe(0);
    const doc = parseJson(result.stdout);
    expect(doc).toMatchObject({
      results: expect.any(Array),
      summary: { total: 1, passed: 1, aborted: false },
      model: { resolved: 'fake-jev-pass-resolved', pinned: false },
    });
    expect(nonEmptyLines(result.stdout)).toHaveLength(1);
    // Progress events render on stderr as info lines (render-events.ts); nothing else lands there.
    for (const line of nonEmptyLines(result.stderr)) expect(line).toMatch(/^(warn|info) /);
  });

  test('--json with a config warning puts the warning on stderr only', () => {
    const result = runVet(['run', '--json'], freshProject(), fixtureEnv('pass'));
    expect(result.stderr).toContain('thresholds.default');
    expect(result.stdout).not.toContain('thresholds.default');
  });

  test('exit code is 1 when a case fails', () => {
    const result = runVet(['run', '--json'], freshProject(), fixtureEnv('fail'));
    expect(result.status).toBe(1);
    expect(parseJson(result.stdout)).toMatchObject({ summary: { failed: 1 }, exitCode: 1 });
  });

  test('--gate with no lock refuses with exit 2, even with --allow-unpinned', () => {
    const result = runVet(
      ['run', '--json', '--gate', '--allow-unpinned'],
      freshProject(),
      fixtureEnv('pass'),
    );
    expect(result.status).toBe(2);
    expect(parseJson(result.stdout)).toMatchObject({ exitCode: 2 });
  });

  test('--config loads a config from another directory, rooted there', () => {
    const project = freshProject();
    const result = runVet(
      ['run', '--json', '--config', join(project, 'vetkit.config.ts')],
      tmpdir(),
      fixtureEnv('pass'),
    );
    expect(result.status).toBe(0);
    expect(parseJson(result.stdout)).toMatchObject({ summary: { total: 1, passed: 1 } });
  });

  test('human output has one line per case and a model footer with the pinned flag', () => {
    const result = runVet(['run'], freshProject(), fixtureEnv('fail'));
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/^.*\bfail\b.*case-1.*$/m);
    expect(result.stdout).toMatch(/fake-jev-fail-resolved/);
    expect(result.stdout).toMatch(/pinned: false/);
  });

  test('human mode prints run progress events on stderr, not stdout', () => {
    const result = runVet(['run'], freshProject(), fixtureEnv('pass'));
    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/run: 1 case × 1 criteria/);
    expect(result.stderr).toMatch(/case case-1 \(1\/1\)/);
    expect(result.stderr).toMatch(/run done: 1 verdict, exit 0/);
    expect(result.stdout).not.toMatch(/run done/);
  });

  test('--json keeps stdout exactly one JSON document while progress renders', () => {
    const result = runVet(['run', '--json'], freshProject(), fixtureEnv('pass'));
    expect(result.status).toBe(0);
    expect(nonEmptyLines(result.stdout)).toHaveLength(1);
    expect(parseJson(result.stdout)).toMatchObject({ summary: { total: 1 } });
    expect(result.stdout).not.toMatch(/run done/);
  });

  test('the fixture secret never appears in stdout or stderr', () => {
    for (const args of [['run'], ['run', '--json'], ['run', '--verbose']]) {
      const result = runVet(args, freshProject(), fixtureEnv('pass'));
      expect(result.stdout).not.toContain(SECRET);
      expect(result.stderr).not.toContain(SECRET);
    }
  });

  test('no vetkit.config.ts exits 2 with CONFIG_INVALID and the searched paths', () => {
    const empty = mkdtempSync(join(tmpdir(), 'vetkit-run-empty-'));
    const result = runVet(['run'], empty, fixtureEnv('pass'));
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('CONFIG_INVALID');
    expect(result.stderr).toContain(join(empty, 'vetkit.config'));
  });

  test('SIGINT mid-run prints partial results as one JSON document with summary.aborted and exits 130', async () => {
    const project = freshProject();
    const started = join(project, 'started');
    const child = spawn(process.execPath, [binPath, 'run', '--json'], {
      cwd: project,
      env: fixtureEnv('slow', { VETKIT_FIXTURE_STARTED: started }),
    });
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    const exited = new Promise<number | null>((resolve) => {
      child.on('exit', (code) => resolve(code));
    });
    const deadline = Date.now() + 30_000;
    while (!existsSync(started) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(existsSync(started)).toBe(true);
    child.kill('SIGINT');
    const code = await exited;
    expect(code).toBe(130);
    expect(parseJson(stdout)).toMatchObject({ summary: { aborted: true }, exitCode: 130 });
  }, 60_000);
});

describe('vet run --reporter junit (mol-aq4.7)', () => {
  test('--reporter junit=vet-junit.xml --json writes the file and stdout is exactly one JSON document', () => {
    const project = freshProject();
    const result = runVet(
      ['run', '--reporter', 'junit=vet-junit.xml', '--json'],
      project,
      fixtureEnv('pass'),
    );
    expect(result.status).toBe(0);
    expect(nonEmptyLines(result.stdout)).toHaveLength(1);
    expect(parseJson(result.stdout)).toMatchObject({ summary: { total: 1, passed: 1 } });
    expect(result.stdout).not.toContain('<testsuites');
    const xml = readFileSync(join(project, 'vet-junit.xml'), 'utf8');
    expect(xml).toMatch(/^<\?xml /);
    expect(xml).toContain('<testcase name="case-1::');
  });

  test('--reporter junit=missing/dir/x.xml creates the directory', () => {
    const project = freshProject();
    const result = runVet(
      ['run', '--json', '--reporter', 'junit=missing/dir/x.xml'],
      project,
      fixtureEnv('fail'),
    );
    expect(result.status).toBe(1);
    const xml = readFileSync(join(project, 'missing', 'dir', 'x.xml'), 'utf8');
    expect(xml).toContain('<failure');
  });

  test('plain --reporter junit writes .vet/junit.xml', () => {
    const project = freshProject();
    const result = runVet(['run', '--reporter', 'junit'], project, fixtureEnv('pass'));
    expect(result.status).toBe(0);
    expect(readFileSync(join(project, '.vet', 'junit.xml'), 'utf8')).toContain('<testsuites');
  });

  test('SIGINT with --reporter junit still writes the partial report', async () => {
    const project = freshProject();
    const started = join(project, 'started');
    const child = spawn(process.execPath, [binPath, 'run', '--json', '--reporter', 'junit'], {
      cwd: project,
      env: fixtureEnv('slow', { VETKIT_FIXTURE_STARTED: started }),
    });
    const exited = new Promise<number | null>((resolve) => {
      child.on('exit', (code) => resolve(code));
    });
    const deadline = Date.now() + 30_000;
    while (!existsSync(started) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    child.kill('SIGINT');
    expect(await exited).toBe(130);
    expect(readFileSync(join(project, '.vet', 'junit.xml'), 'utf8')).toContain('<testsuites');
  }, 60_000);
});

function recordPath(project: string): string {
  return join(project, '.vet', 'runs', 'latest.json');
}

function parseObject(text: string): Record<string, unknown> {
  const result = safeParseJson<Record<string, unknown>>(text, { type: 'object' });
  if (!result.ok) throw result.error;
  return result.value;
}

describe('vet run persists .vet/runs/latest.json (mol-p4a.16)', () => {
  test('the record is the --json document plus criteriaPath, casesPath and startedAt', () => {
    const project = freshProject();
    const result = runVet(['run', '--json'], project, fixtureEnv('fail'));
    expect(result.status).toBe(1);
    const doc = parseObject(result.stdout);
    const rec = parseObject(readFileSync(recordPath(project), 'utf8'));
    expect(rec).toEqual({
      ...doc,
      criteriaPath: join(project, 'evals', 'criteria.yaml'),
      casesPath: join(project, 'evals', 'cases'),
      startedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
  });

  test('human mode writes the record too', () => {
    const project = freshProject();
    const result = runVet(['run'], project, fixtureEnv('pass'));
    expect(result.status).toBe(0);
    expect(parseJson(readFileSync(recordPath(project), 'utf8'))).toMatchObject({
      summary: { total: 1, passed: 1 },
      exitCode: 0,
    });
  });

  test('SIGINT partial runs are written with summary.aborted', async () => {
    const project = freshProject();
    const started = join(project, 'started');
    const child = spawn(process.execPath, [binPath, 'run', '--json'], {
      cwd: project,
      env: fixtureEnv('slow', { VETKIT_FIXTURE_STARTED: started }),
    });
    const exited = new Promise<number | null>((resolve) => {
      child.on('exit', (code) => resolve(code));
    });
    const deadline = Date.now() + 30_000;
    while (!existsSync(started) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    child.kill('SIGINT');
    expect(await exited).toBe(130);
    expect(parseJson(readFileSync(recordPath(project), 'utf8'))).toMatchObject({
      summary: { aborted: true },
      exitCode: 130,
    });
  }, 60_000);
});

describe('vet run and evals/cases/pending/ (dh8.3, root DECISION UX brief C11)', () => {
  test('no pending/ directory: the stderr pending-count line reads 0', () => {
    const result = runVet(['run'], freshProject(), fixtureEnv('pass'));
    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/\b0\b.*pending/);
  });

  test('a case under evals/cases/pending/ is not judged, and the stderr line counts it', () => {
    const project = freshProject();
    const pendingDir = join(project, 'evals', 'cases', 'pending');
    mkdirSync(pendingDir, { recursive: true });
    writeFileSync(
      join(pendingDir, 'promoted-2026-09-29.jsonl'),
      `${JSON.stringify({
        id: 'promoted-trace-1-tone',
        input: { state: 'User: hi' },
        provenance: {
          promotedFrom: { traceId: 'trace-1', criterionId: 'tone', at: '2026-09-29T00:00:00.000Z' },
        },
        tags: [],
      })}\n`,
    );
    const result = runVet(['run', '--json'], project, fixtureEnv('pass'));
    expect(result.status).toBe(0);
    // Only the fixture's one non-pending case was judged; the pending one never reaches the loader.
    expect(parseJson(result.stdout)).toMatchObject({ summary: { total: 1 } });
    expect(result.stderr).toMatch(/\b1\b.*pending/);
  });
});
