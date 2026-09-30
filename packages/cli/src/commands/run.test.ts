import { spawn, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JEV_CREDENTIAL_PRIORITY, JEV_PRESETS } from '@vetkit/judge-jev';
import { runRecordSchema, safeParseJson, VetError } from '@vetkit/spec';
import { beforeAll, describe, expect, test } from 'vitest';
import { ensureCliBuilt } from '../test-support/build-cli.js';
import { hintFor } from '../errors.ts';
import { createProgram } from '../program.ts';

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
    expect(parseJson(result.stdout)).toMatchObject({
      exitCode: 2,
      results: [],
      summary: { passed: 0, failed: 0 },
    });
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

describe('vet run --reporter junit', () => {
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

describe('vet run persists .vet/runs/latest.json', () => {
  test('the record is the --json document plus $schema, relative criteriaPath/casesPath, startedAt and gateRequested', () => {
    const project = freshProject();
    const result = runVet(['run', '--json'], project, fixtureEnv('fail'));
    expect(result.status).toBe(1);
    const doc = parseObject(result.stdout);
    const rec = parseObject(readFileSync(recordPath(project), 'utf8'));
    expect(rec).toEqual({
      ...doc,
      $schema: runRecordSchema.$id,
      criteriaPath: 'evals/criteria.yaml',
      casesPath: 'evals/cases',
      startedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      gateRequested: false,
    });
  });

  test('the run record carries schemaVersion 1 and stdout does not', () => {
    const project = freshProject();
    const doc = parseObject(runVet(['run', '--json'], project, fixtureEnv('pass')).stdout);
    const rec = parseObject(readFileSync(recordPath(project), 'utf8'));
    expect(rec['schemaVersion']).toBe(1);
    expect(doc).not.toHaveProperty('schemaVersion');
  });

  test('stdout --json carries no $schema, criteriaPath, casesPath or gateRequested keys', () => {
    const doc = parseObject(runVet(['run', '--json'], freshProject(), fixtureEnv('pass')).stdout);
    for (const key of ['$schema', 'criteriaPath', 'casesPath', 'gateRequested']) {
      expect(doc).not.toHaveProperty(key);
    }
  });

  test('a per-run file .vet/runs/<stamp>.json exists and equals latest.json', () => {
    const project = freshProject();
    runVet(['run', '--json'], project, fixtureEnv('pass'));
    const runsDir = join(project, '.vet', 'runs');
    const perRun = readdirSync(runsDir).filter((f) => f !== 'latest.json' && f.endsWith('.json'));
    expect(perRun).toHaveLength(1);
    const rec = parseObject(readFileSync(recordPath(project), 'utf8'));
    const stamp = String(rec['startedAt']).replaceAll(/[:.]/g, '-');
    expect(perRun[0]).toBe(`${stamp}.json`);
    expect(readFileSync(join(runsDir, perRun[0] ?? ''), 'utf8')).toBe(
      readFileSync(recordPath(project), 'utf8'),
    );
  });

  test('--gate with no lock writes gateRequested: true and results: []', () => {
    const project = freshProject();
    const result = runVet(['run', '--json', '--gate'], project, fixtureEnv('pass'));
    expect(result.status).toBe(2);
    expect(parseObject(readFileSync(recordPath(project), 'utf8'))).toMatchObject({
      gateRequested: true,
      results: [],
    });
  });

  test('--criteria outside the config directory is stored as a ../ relative path', () => {
    const project = freshProject();
    const outside = mkdtempSync(join(tmpdir(), 'vetkit-run-outside-'));
    const criteria = join(outside, 'c.yaml');
    cpSync(join(project, 'evals', 'criteria.yaml'), criteria);
    const result = runVet(['run', '--json', '--criteria', criteria], project, fixtureEnv('pass'));
    expect(result.status).toBe(0);
    const rec = parseObject(readFileSync(recordPath(project), 'utf8'));
    expect(rec['criteriaPath']).toBe(relative(project, criteria).split(sep).join('/'));
    expect(String(rec['criteriaPath']).startsWith('../')).toBe(true);
  });

  test('a stale latest.json with absolute paths makes vet rerun and vet cases promote exit 2 with a message that names `vet run`', () => {
    const project = freshProject();
    runVet(['run', '--json'], project, fixtureEnv('pass'));
    const stale = parseObject(readFileSync(recordPath(project), 'utf8'));
    delete stale['$schema'];
    stale['criteriaPath'] = join(project, 'evals', 'criteria.yaml');
    stale['casesPath'] = join(project, 'evals', 'cases');
    writeFileSync(recordPath(project), JSON.stringify(stale));
    for (const args of [['rerun'], ['cases', 'promote', 'x:y']]) {
      const result = runVet(args, project, fixtureEnv('pass'));
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('vet run');
    }
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

describe('vet run default criteria/cases paths', () => {
  // `vet init --out <dir>` writes criteria.yaml and cases/ at the top level of <dir>, with no
  // evals/ subdirectory; `vet run` falls back to <rootDir> when evals/ is absent, so a run there
  // still finds its cases.
  test('falls back to <configDir>/criteria.yaml and <configDir>/cases when evals/ is absent', () => {
    const project = freshProject();
    cpSync(join(project, 'evals', 'criteria.yaml'), join(project, 'criteria.yaml'));
    cpSync(join(project, 'evals', 'cases'), join(project, 'cases'), { recursive: true });
    rmSync(join(project, 'evals'), { recursive: true, force: true });
    const result = runVet(['run', '--json'], project, fixtureEnv('pass'));
    expect(result.status).toBe(0);
    expect(parseJson(result.stdout)).toMatchObject({ summary: { total: 1, passed: 1 } });
  });

  test('evals/ still wins over a top-level layout when both exist', () => {
    const project = freshProject();
    writeFileSync(
      join(project, 'criteria.yaml'),
      readFileSync(join(project, 'evals', 'criteria.yaml'), 'utf8'),
    );
    mkdirSync(join(project, 'cases'), { recursive: true });
    writeFileSync(
      join(project, 'cases', 'extra.jsonl'),
      [
        { id: 'extra-1', input: { state: 'User: hi' }, provenance: null, tags: [] },
        { id: 'extra-2', input: { state: 'User: hi' }, provenance: null, tags: [] },
      ]
        .map((c) => JSON.stringify(c))
        .join('\n') + '\n',
    );
    // Both layouts pass under fixtureEnv('pass'); only their case counts differ (1 vs 2), so
    // evals/'s count winning proves it was chosen over the top-level one.
    const result = runVet(['run', '--json'], project, fixtureEnv('pass'));
    expect(result.status).toBe(0);
    expect(parseJson(result.stdout)).toMatchObject({ summary: { total: 1, passed: 1 } });
  });
});

describe('vet run and evals/cases/pending/ (promotion rule: one file per day)', () => {
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

// A copy of the fixture project whose judge is the shipped demo judge, imported from the
// built package entry (dist/index.js) so the config exercises the real public export.
function demoProject(): string {
  const dir = freshProject();
  const entry = pathToFileURL(fileURLToPath(new URL('../../dist/index.js', import.meta.url)));
  writeFileSync(
    join(dir, 'vetkit.config.ts'),
    `import { demoJudge } from '${entry.href}';\nexport default { judge: demoJudge };\n`,
  );
  return dir;
}

function credentialList(): string {
  return JEV_CREDENTIAL_PRIORITY.map((p) =>
    JEV_PRESETS[p].credentials.map((c) => c.name).join(' + '),
  ).join(', ');
}

function isResults(doc: unknown): doc is { results: { cacheHit?: unknown }[] } {
  return typeof doc === 'object' && doc !== null && 'results' in doc && Array.isArray(doc.results);
}

function demoHintLines(stderr: string): string[] {
  return nonEmptyLines(stderr).filter((line) => line.includes('demo judge:'));
}

describe('vet run with the demo judge', () => {
  test('demo judge: pretty stdout ends with model: demo (transport demo, pinned: false) and exits 0 on the scaffold cases', () => {
    const result = runVet(['run'], demoProject(), fixtureEnv('pass'));
    expect(result.status).toBe(0);
    const lines = nonEmptyLines(result.stdout);
    expect(lines.at(-2)).toBe('model: demo (transport demo, pinned: false)');
    expect(lines.at(-1)).toMatch(/^gate: uncalibrated/);
  });

  test('demo judge: stderr has exactly one warn line starting demo judge: naming every JEV credential var, .env and vet init --force', () => {
    const result = runVet(['run'], demoProject(), fixtureEnv('pass'));
    const hints = demoHintLines(result.stderr);
    expect(hints).toHaveLength(1);
    const [hint = ''] = hints;
    expect(hint.startsWith('warn demo judge:')).toBe(true);
    expect(hint).toContain('placeholder');
    expect(hint).toContain(credentialList());
    expect(hint).toContain('.env');
    expect(hint.endsWith('vet init --force')).toBe(true);
    expect(result.stdout).not.toContain('demo judge:');
  });

  test('demo judge: --json stdout is one document with model.transport demo and the hint stays on stderr', () => {
    const result = runVet(['run', '--json'], demoProject(), fixtureEnv('pass'));
    expect(result.status).toBe(0);
    expect(nonEmptyLines(result.stdout)).toHaveLength(1);
    expect(parseJson(result.stdout)).toMatchObject({ model: { transport: 'demo' } });
    expect(result.stdout).not.toContain('demo judge:');
    expect(demoHintLines(result.stderr)).toHaveLength(1);
  });

  test('a non-demo judge prints no demo hint', () => {
    const result = runVet(['run'], freshProject(), fixtureEnv('pass'));
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('demo judge:');
  });

  test('the hint names no flag that vet init lacks', () => {
    const result = runVet(['run'], demoProject(), fixtureEnv('pass'));
    const [hint = ''] = demoHintLines(result.stderr);
    const flags = hint.match(/--\w+/g) ?? [];
    expect(flags.length).toBeGreaterThan(0);
    const init = createProgram().commands.find((c) => c.name() === 'init');
    const known = init?.options.map((o) => o.long) ?? [];
    for (const flag of flags) expect(known).toContain(flag);
  });

  test('demo judge: two consecutive runs create no .vet/cache directory and every results[].cacheHit is false', () => {
    const project = demoProject();
    runVet(['run', '--json'], project, fixtureEnv('pass'));
    const second = runVet(['run', '--json'], project, fixtureEnv('pass'));
    expect(existsSync(join(project, '.vet', 'cache'))).toBe(false);
    const doc = parseJson(second.stdout);
    expect(doc).toMatchObject({ results: expect.any(Array) });
    const results: { cacheHit?: unknown }[] = isResults(doc) ? doc.results : [];
    expect(results.length).toBeGreaterThan(0);
    for (const v of results) expect(v.cacheHit).toBe(false);
  });

  test('demo judge: .vet/runs/latest.json is still written and its model.transport is demo', () => {
    const project = demoProject();
    runVet(['run', '--json'], project, fixtureEnv('pass'));
    const record = parseJson(readFileSync(join(project, '.vet', 'runs', 'latest.json'), 'utf8'));
    expect(record).toMatchObject({ model: { transport: 'demo' } });
  });

  test('fixture judge (transport fake) still caches: second run has cacheHit true', () => {
    const project = freshProject();
    runVet(['run', '--json'], project, fixtureEnv('pass'));
    const second = runVet(['run', '--json'], project, fixtureEnv('pass'));
    const doc = parseJson(second.stdout);
    expect(doc).toMatchObject({ results: expect.any(Array) });
    const results: { cacheHit?: unknown }[] = isResults(doc) ? doc.results : [];
    expect(results.some((v) => v.cacheHit === true)).toBe(true);
  });
});

async function fixtureRejection(mode: string): Promise<unknown> {
  process.env['VETKIT_FIXTURE_MODE'] = mode;
  const href = `${pathToFileURL(join(fixtureDir, 'vetkit.config.ts')).href}?mode=${mode}`;
  const mod: unknown = await import(href);
  const judge = getDoJudge(mod);
  return judge({ questions: { q: {} } }).catch((e: unknown) => e);
}

function getDoJudge(mod: unknown): (req: object) => Promise<unknown> {
  if (typeof mod === 'object' && mod !== null && 'default' in mod) {
    const cfg = mod.default;
    if (typeof cfg === 'object' && cfg !== null && 'judge' in cfg) {
      const judge = cfg.judge;
      if (typeof judge === 'object' && judge !== null && 'doJudge' in judge) {
        const fn = judge.doJudge;
        if (typeof fn === 'function') return (req) => Promise.resolve(fn.call(judge, req));
      }
    }
  }
  throw new Error('fixture has no default.judge.doJudge');
}

function withSink(mode: string): Result {
  const project = freshProject();
  const configPath = join(project, 'vetkit.config.ts');
  const sink =
    "{ specVersion: 'v1', id: 'otel/logs', capabilities: { batch: 10, idempotent: true }, async doWrite(batch) { return { accepted: batch.map((v) => v.id), rejected: [] }; } }";
  writeFileSync(
    configPath,
    readFileSync(configPath, 'utf8').replace(
      'export default { judge };',
      `export default { judge, sinks: [${sink}] };`,
    ),
  );
  return runVet(['run', '--sink', 'otel', '--json'], project, fixtureEnv(mode));
}

describe('vet run exit 3 for unscored-only runs', () => {
  test('a judge that throws on every case exits 3 with an UNSCORED_ONLY line', () => {
    const result = runVet(['run'], freshProject(), fixtureEnv('down'));
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('[UNSCORED_ONLY]');
    expect(result.stderr).toContain(hintFor('UNSCORED_ONLY'));
    expect(result.stdout).toContain('0 passed, 0 failed, 1 unscored of 1');
  });

  test('--json on an unscored-only run reports exitCode 3', () => {
    const result = runVet(['run', '--json'], freshProject(), fixtureEnv('down'));
    expect(result.status).toBe(3);
    const doc = parseObject(result.stdout);
    expect(doc['exitCode']).toBe(3);
    expect(doc['summary']).toMatchObject({ unscored: 1, total: 1 });
    for (const line of nonEmptyLines(result.stderr)) expect(line).not.toMatch(/^\s*[{[]/);
  });

  test('a scored failure still exits 1', () => {
    expect(runVet(['run', '--json'], freshProject(), fixtureEnv('fail')).status).toBe(1);
  });

  test('a passing run still exits 0', () => {
    expect(runVet(['run', '--json'], freshProject(), fixtureEnv('pass')).status).toBe(0);
  });

  test('a throttled judge that never recovers exits 3', () => {
    const result = runVet(['run', '--json'], freshProject(), fixtureEnv('throttled'));
    expect(result.status).toBe(3);
    expect(parseObject(result.stdout)['exitCode']).toBe(3);
  }, 60_000);

  test('--sink downgrades an unscored-only run to 0, not a scored failure', () => {
    expect(withSink('down').status).toBe(0);
    expect(withSink('fail').status).toBe(1);
  }, 60_000);

  test('fixture failure modes throw marker errors with the documented code', async () => {
    const expected = {
      throttled: 'JUDGE_UNAVAILABLE',
      unauthorized: 'JUDGE_UNAUTHORIZED',
      'no-credit': 'JUDGE_UNAVAILABLE',
    } as const;
    const previous = process.env['VETKIT_FIXTURE_MODE'];
    try {
      for (const [mode, code] of Object.entries(expected)) {
        const thrown = await fixtureRejection(mode);
        expect(VetError.isInstance(thrown), mode).toBe(true);
        expect(thrown).toMatchObject({ code });
      }
      const down = await fixtureRejection('down');
      expect(down).toBeInstanceOf(Error);
      expect(VetError.isInstance(down)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env['VETKIT_FIXTURE_MODE'];
      else process.env['VETKIT_FIXTURE_MODE'] = previous;
    }
  });
});

const NO_LOCK_LINE =
  'gate: uncalibrated — thresholds are the 0.5 placeholder; run `vet validate` to calibrate';
const LOCK_NO_GATE_LINE =
  'gate: uncalibrated — criteria.lock.json present; pass --gate to enforce it';
const CALIBRATED_LINE = 'gate: calibrated — 1/1 criteria calibrated (criteria.lock.json)';

// A calibrated lock for the fixture judge in 'pass' mode (unpinned, so --allow-unpinned).
function plantLock(project: string, resolved = 'fake-jev-pass-resolved'): string {
  const lockPath = join(project, 'criteria.lock.json');
  const pass = 'pass';
  const lock = {
    lockVersion: 1,
    model: { requested: 'fake-jev-pass', resolved, transport: 'fake', pinned: false },
    criteria: {
      tone: {
        wordingHash: 'a'.repeat(64),
        status: 'calibrated',
        threshold: 0.5,
        tolerance: 0,
        gauntlet: {
          paraphrase: pass,
          polarity: pass,
          injection: pass,
          master_key: pass,
          label_permutation: pass,
          constant_output: pass,
          position_swap: pass,
          length: pass,
        },
        reasons: [],
        labelCount: 120,
      },
    },
    datasetHash: 'd'.repeat(64),
  };
  writeFileSync(lockPath, JSON.stringify(lock));
  return lockPath;
}

describe('vet run gate label', () => {
  test('pretty output ends with gate: uncalibrated and the validate hint', () => {
    const result = runVet(['run'], freshProject(), fixtureEnv('pass'));
    expect(result.status).toBe(0);
    expect(nonEmptyLines(result.stdout).at(-1)).toBe(NO_LOCK_LINE);
    expect(result.stdout).not.toContain('gate: calibrated');
  });

  test('with a lock and no --gate the hint says pass --gate', () => {
    const project = freshProject();
    plantLock(project);
    const result = runVet(['run'], project, fixtureEnv('pass'));
    expect(result.status).toBe(0);
    expect(nonEmptyLines(result.stdout).at(-1)).toBe(LOCK_NO_GATE_LINE);
    expect(result.stdout).not.toContain('gate: calibrated');
  });

  test('--gate --allow-unpinned on a calibrated lock ends with the calibrated line', () => {
    const project = freshProject();
    plantLock(project);
    const result = runVet(['run', '--gate', '--allow-unpinned'], project, fixtureEnv('pass'));
    expect(result.status).toBe(0);
    expect(nonEmptyLines(result.stdout).at(-1)).toBe(CALIBRATED_LINE);
  });

  test('--json carries gate {tier, lockPath, calibratedCriteria, judgedCriteria}', () => {
    const project = freshProject();
    const none = runVet(['run', '--json'], project, fixtureEnv('pass'));
    expect(parseJson(none.stdout)).toMatchObject({
      gate: { tier: 'uncalibrated', lockPath: null, calibratedCriteria: 0, judgedCriteria: 1 },
    });

    const lockPath = plantLock(project);
    const gated = runVet(
      ['run', '--json', '--gate', '--allow-unpinned'],
      project,
      fixtureEnv('pass'),
    );
    expect(gated.status).toBe(0);
    expect(parseJson(gated.stdout)).toMatchObject({
      gate: { tier: 'calibrated', lockPath, calibratedCriteria: 1, judgedCriteria: 1 },
    });
    expect(gated.stdout).toContain('"gate":{');
  });

  test('a refused --gate run reports tier uncalibrated and exits 2', () => {
    const result = runVet(['run', '--json', '--gate'], freshProject(), fixtureEnv('pass'));
    expect(result.status).toBe(2);
    expect(parseJson(result.stdout)).toMatchObject({
      exitCode: 2,
      gate: { tier: 'uncalibrated', lockPath: null },
    });
  });

  test('latest.json carries gate', () => {
    const project = freshProject();
    const lockPath = plantLock(project);
    const result = runVet(['run', '--gate', '--allow-unpinned'], project, fixtureEnv('pass'));
    expect(result.status).toBe(0);
    expect(parseJson(readFileSync(recordPath(project), 'utf8'))).toMatchObject({
      gate: { tier: 'calibrated', lockPath, calibratedCriteria: 1, judgedCriteria: 1 },
    });
  });
});

describe('vet run --repeat', () => {
  test('--repeat 3 judges each case three times (results length) and --json carries repeats', () => {
    const result = runVet(['run', '--json', '--repeat', '3'], freshProject(), fixtureEnv('pass'));
    expect(result.status).toBe(0);
    const doc = parseJson(result.stdout);
    expect(doc).toMatchObject({
      repeats: 3,
      summary: { flaky: 0, passed: 1 },
      results: [{}, {}, {}],
    });
  });

  test('an invalid --repeat exits 2 naming the flag', () => {
    for (const raw of ['0', 'x']) {
      const result = runVet(['run', '--repeat', raw], freshProject(), fixtureEnv('pass'));
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('CONFIG_INVALID');
      expect(result.stderr).toContain(`--repeat must be a positive integer, got '${raw}'`);
    }
  });

  test('pretty output prints flaky <id> (spread x.xx) with an alternating fixture judge', () => {
    const result = runVet(['run', '--repeat', '3'], freshProject(), fixtureEnv('alternate'));
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^flaky case-1 \(spread 0\.80\)$/m);
    expect(result.stdout).toMatch(/, 1 flaky/);
  });
});

function noCredentials(): NodeJS.ProcessEnv {
  const env = fixtureEnv('pass', { CEV_JUDGE_BASE_URL: 'http://127.0.0.1:9' });
  delete env['AI_GATEWAY_API_KEY'];
  delete env['OPENROUTER_API_KEY'];
  delete env['VETKIT_FIXTURE_KEY'];
  return env;
}

// The recording project's own config is an in-process judge; the replay project swaps in a
// descriptor judge whose credential is unset, so any real call would fail.
function replayProject(recordDir: string): string {
  const dir = freshProject();
  rmSync(join(dir, 'vetkit.config.ts'));
  writeFileSync(
    join(dir, 'vetkit.config.json'),
    JSON.stringify({
      judge: { kind: 'typesafe-compatible', preset: 'vercel', apiKeyEnv: 'AI_GATEWAY_API_KEY' },
    }),
  );
  cpSync(recordDir, join(dir, 'rec'), { recursive: true });
  return dir;
}

function withoutCacheHit(doc: unknown): unknown {
  const results =
    typeof doc === 'object' && doc !== null && 'results' in doc && Array.isArray(doc.results)
      ? doc.results
      : [];
  return results.map((v: Record<string, unknown>) => {
    const { cacheHit: _cacheHit, ...rest } = v;
    return rest;
  });
}

describe('vet run --record / --replay', () => {
  test('record then replay with the credential env var deleted and a refused judge URL gives identical results', () => {
    const project = freshProject();
    const recorded = runVet(['run', '--json', '--record', 'rec'], project, fixtureEnv('pass'));
    expect(recorded.status).toBe(0);
    const replayed = runVet(
      ['run', '--json', '--replay', 'rec'],
      replayProject(join(project, 'rec')),
      noCredentials(),
    );
    expect(replayed.status).toBe(recorded.status);
    expect(withoutCacheHit(parseJson(replayed.stdout))).toEqual(
      withoutCacheHit(parseJson(recorded.stdout)),
    );
  });

  test('record and replay together exit 2', () => {
    const result = runVet(
      ['run', '--record', 'a', '--replay', 'b'],
      freshProject(),
      fixtureEnv('pass'),
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--record and --replay are exclusive');
  });

  test('recorded files contain no canary key', () => {
    const project = freshProject();
    const result = runVet(['run', '--json', '--record', 'rec'], project, fixtureEnv('pass'));
    expect(result.status).toBe(0);
    const files = readdirSync(join(project, 'rec'));
    expect(files).toContain('manifest.json');
    expect(files.length).toBeGreaterThan(1);
    for (const file of files) {
      expect(readFileSync(join(project, 'rec', file), 'utf8')).not.toContain(SECRET);
    }
  });
});

describe('vet run --reporter md/html', () => {
  test("writes .vet/report.md containing the counts, wording 'Is the reply polite?', 'uncalibrated', 'fake-jev-fail-resolved', 'pinned: false', 'Dataset', the version and the repo link", () => {
    const project = freshProject();
    const result = runVet(['run', '--json', '--reporter', 'md'], project, fixtureEnv('fail'));
    expect(result.status).toBe(1);
    const md = readFileSync(join(project, '.vet', 'report.md'), 'utf8');
    expect(md.startsWith('### vetkit eval report')).toBe(true);
    expect(md).toContain('0 passed · 1 failed · 0 unscored** of 1');
    expect(md).toContain('Is the reply polite?');
    expect(md).toContain('Calibration: uncalibrated');
    expect(md).toContain('fake-jev-fail-resolved');
    expect(md).toContain('pinned: false');
    expect(md).toContain('Dataset `');
    expect(md).toContain('https://github.com/MelsovCOZY/vetkit');
    expect(existsSync(join(project, '.vet', 'junit.xml'))).toBe(false);
    expect(existsSync(join(project, '.vet', 'report.html'))).toBe(false);
    const version = parseObject(
      readFileSync(join(fixtureDir, '..', '..', '..', 'packages', 'cli', 'package.json'), 'utf8'),
    )['version'];
    expect(md).toContain(`vetkit ${String(version)}`);
  });

  test('writes .vet/report.html starting with <!doctype html> and containing no <script', () => {
    const project = freshProject();
    const result = runVet(['run', '--json', '--reporter', 'html'], project, fixtureEnv('pass'));
    expect(result.status).toBe(0);
    const html = readFileSync(join(project, '.vet', 'report.html'), 'utf8');
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).not.toContain('<script');
  });

  test('--reporter md=out/nested/report.md creates the directories', () => {
    const project = freshProject();
    runVet(['run', '--json', '--reporter', 'md=out/nested/report.md'], project, fixtureEnv('pass'));
    expect(existsSync(join(project, 'out', 'nested', 'report.md'))).toBe(true);
  });

  test("case text 'Hello! How can I help?' is absent without --include-cases and present with it", () => {
    const without = freshProject();
    runVet(['run', '--json', '--reporter', 'md,html'], without, fixtureEnv('pass'));
    for (const file of ['report.md', 'report.html']) {
      expect(readFileSync(join(without, '.vet', file), 'utf8')).not.toContain(
        'Hello! How can I help?',
      );
    }
    const withCases = freshProject();
    runVet(
      ['run', '--json', '--reporter', 'md,html', '--include-cases'],
      withCases,
      fixtureEnv('pass'),
    );
    for (const file of ['report.md', 'report.html']) {
      expect(readFileSync(join(withCases, '.vet', file), 'utf8')).toContain(
        'Hello! How can I help?',
      );
    }
  });

  test('the fixture secret never appears in either report', () => {
    const project = freshProject();
    runVet(['run', '--reporter', 'md,html', '--include-cases'], project, fixtureEnv('fail'));
    for (const file of ['report.md', 'report.html']) {
      expect(readFileSync(join(project, '.vet', file), 'utf8')).not.toContain(SECRET);
    }
  });

  test('--json stdout is still exactly one JSON document with no report keys', () => {
    const project = freshProject();
    const result = runVet(['run', '--json', '--reporter', 'md,html'], project, fixtureEnv('pass'));
    expect(nonEmptyLines(result.stdout)).toHaveLength(1);
    const doc = parseObject(result.stdout);
    for (const key of ['report', 'reports', 'md', 'html', 'badge']) {
      expect(doc).not.toHaveProperty(key);
    }
    expect(result.stdout).not.toContain('### vetkit');
  });

  test("pretty output lists 'report: .vet/report.md'", () => {
    const project = freshProject();
    const result = runVet(['run', '--reporter', 'md,html'], project, fixtureEnv('pass'));
    expect(result.stdout).toContain('report: .vet/report.md');
    expect(result.stdout).toContain('report: .vet/report.html');
  });

  test('--gate with no lock (exit 2) still writes reports carrying the gate reason', () => {
    const project = freshProject();
    const result = runVet(
      ['run', '--json', '--gate', '--reporter', 'md'],
      project,
      fixtureEnv('pass'),
    );
    expect(result.status).toBe(2);
    const md = readFileSync(join(project, '.vet', 'report.md'), 'utf8');
    expect(md).toContain('Gate refused:');
    expect(md).toContain('exit 2');
  });

  test('a repeated reporter kind is a usage error (exit 2)', () => {
    const result = runVet(['run', '--reporter', 'md,md=x.md'], freshProject(), fixtureEnv('pass'));
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('given twice');
  });

  test('SIGINT with --reporter md still writes the partial report marked aborted', async () => {
    const project = freshProject();
    const started = join(project, 'started');
    const child = spawn(process.execPath, [binPath, 'run', '--json', '--reporter', 'md'], {
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
    const md = readFileSync(join(project, '.vet', 'report.md'), 'utf8');
    expect(md).toContain('(aborted)');
    const badge = parseObject(readFileSync(join(project, '.vet', 'badge.json'), 'utf8'));
    expect(badge['message']).toBe('uncalibrated · aborted');
    expect(badge['color']).toBe('lightgrey');
  }, 60_000);
});

describe('vet run writes .vet/badge.json', () => {
  test("every vet run writes .vet/badge.json; after a fail-mode run its message is 'uncalibrated · fail' and color 'red'; after a pass-mode run 'uncalibrated · pass' and 'yellow'", () => {
    const failing = freshProject();
    const failRun = runVet(['run', '--json'], failing, fixtureEnv('fail'));
    expect(failRun.status).toBe(1);
    expect(parseObject(readFileSync(join(failing, '.vet', 'badge.json'), 'utf8'))).toEqual({
      schemaVersion: 1,
      label: 'vetkit',
      message: 'uncalibrated · fail',
      color: 'red',
    });
    const passing = freshProject();
    const passRun = runVet(['run'], passing, fixtureEnv('pass'));
    expect(passRun.status).toBe(0);
    expect(parseObject(readFileSync(join(passing, '.vet', 'badge.json'), 'utf8'))).toEqual({
      schemaVersion: 1,
      label: 'vetkit',
      message: 'uncalibrated · pass',
      color: 'yellow',
    });
  });

  test('a gate-refused run (exit 2) writes a gate refused, orange badge and adds nothing to stdout', () => {
    const project = freshProject();
    const result = runVet(['run', '--json', '--gate'], project, fixtureEnv('pass'));
    expect(result.status).toBe(2);
    expect(nonEmptyLines(result.stdout)).toHaveLength(1);
    expect(result.stdout).not.toContain('badge');
    expect(parseObject(readFileSync(join(project, '.vet', 'badge.json'), 'utf8'))).toMatchObject({
      message: 'uncalibrated · gate refused',
      color: 'orange',
    });
  });
});
