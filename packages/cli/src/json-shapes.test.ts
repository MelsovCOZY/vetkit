// Every `vet <command> --json` document validates against its published schema in JSON_SHAPES.
// Commands are spawned from packages/cli/dist/bin.js (like cli-json.test.ts) inside temp copies of
// fixtures/cli/{run,init,watch}: in-process fake judge and generator, no network.
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeParseJson, validateJson } from '@vetkit/spec';
import type { Command } from 'commander';
import { beforeAll, describe, expect, test } from 'vitest';
import { ENV_VARS } from './commands/doctor.ts';
import { JSON_SHAPES, renderJsonShapesMarkdown, type JsonShapeKey } from './json-shapes.ts';
import { createProgram } from './program.ts';
import { ensureCliBuilt } from './test-support/build-cli.js';

const binPath = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
const fixtures = fileURLToPath(new URL('../../../fixtures', import.meta.url));

beforeAll(async () => {
  await ensureCliBuilt();
}, 180_000);

// No judge credential in the child env, so nothing probes the network.
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
  for (const v of ENV_VARS) delete env[v.name];
  delete env.CEV_LOG_LEVEL;
  delete env.CI;
  return { ...env, ...extra };
}

interface Spawned {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number | null;
}

function runVet(args: readonly string[], cwd: string, extraEnv: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [binPath, ...args], {
    cwd,
    encoding: 'utf8',
    env: cleanEnv(extraEnv),
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status } satisfies Spawned;
}

function parseJson(text: string): unknown {
  const result = safeParseJson<unknown>(text, {});
  if (!result.ok) throw result.error;
  return result.value;
}

function projectFrom(fixture: 'run' | 'init' | 'watch'): string {
  const dir = mkdtempSync(join(tmpdir(), `vetkit-shapes-${fixture}-`));
  cpSync(join(fixtures, 'cli', fixture), dir, { recursive: true });
  return dir;
}

const CASE_COUNT = 120;

// The run fixture plus CASE_COUNT cases and a label CSV (half pass, half fail) beside it, enough
// for `vet validate` to write a lock. The CSV is not imported yet.
function labelledProject(): { dir: string; csv: string } {
  const dir = projectFrom('run');
  const cases: string[] = [];
  const rows = ['case_id,criterion_id,label,labeler,labeled_at'];
  for (let i = 0; i < CASE_COUNT; i += 1) {
    const state = `User: hi ${String(i)}\nAssistant: Hello number ${String(i)}, how can I help?`;
    cases.push(
      JSON.stringify({ id: `c${String(i)}`, input: { state }, provenance: null, tags: [] }),
    );
    rows.push(`c${String(i)},tone,${i % 2 === 0 ? 'fail' : 'pass'},me,2026-09-29T00:00:00.000Z`);
  }
  writeFileSync(join(dir, 'evals', 'cases', 'cases.jsonl'), `${cases.join('\n')}\n`);
  const csv = join(dir, 'labels-in.csv');
  writeFileSync(csv, `${rows.join('\n')}\n`);
  return { dir, csv };
}

// Labelled project with the labels imported and the lock written.
function validatedProject(): string {
  const { dir, csv } = labelledProject();
  expect(runVet(['label', '--from', csv], dir).status).toBe(0);
  expect(runVet(['validate'], dir).status).toBe(0);
  return dir;
}

// A judge that always answers below 0.5 confidence, so `vet rerun` (no lock) finds disputed verdicts.
function disputedProject(): string {
  const dir = projectFrom('run');
  const config = join(dir, 'vetkit.config.ts');
  writeFileSync(
    config,
    readFileSync(config, 'utf8').replaceAll('confidence: 0.9', 'confidence: 0.3'),
  );
  expect(runVet(['run'], dir).status).toBe(0);
  return dir;
}

// One promotable failing verdict: a case with a traceId judged by the failing fake judge.
function failedRunProject(): string {
  const dir = projectFrom('run');
  const line = {
    id: 'case-1',
    input: { state: 'User: hi' },
    traceId: 't1',
    provenance: null,
    tags: [],
  };
  writeFileSync(join(dir, 'evals', 'cases', 'cases.jsonl'), `${JSON.stringify(line)}\n`);
  expect(runVet(['run'], dir, { VETKIT_FIXTURE_MODE: 'fail' }).status).toBe(1);
  return dir;
}

interface Invocation {
  readonly cwd: string;
  readonly args: readonly string[];
  readonly env?: Record<string, string>;
  readonly exits: readonly number[];
}

const otlpFile = join(fixtures, 'otlp', 'gen_ai-latest.json');

// key -> how to produce that command's document. Setup runs lazily inside each test.
const INVOCATIONS: Record<Exclude<JsonShapeKey, 'watch' | 'cases review'>, () => Invocation> = {
  '--version': () => ({ cwd: tmpdir(), args: ['--version', '--json'], exits: [0] }),
  doctor: () => ({ cwd: projectFrom('run'), args: ['doctor', '--json'], exits: [0, 1] }),
  init: () => ({
    cwd: mkdtempSync(join(tmpdir(), 'vetkit-shapes-empty-')),
    args: ['init', '--json'],
    exits: [0],
  }),
  'init --source': () => ({
    cwd: projectFrom('init'),
    args: ['init', '--source', 'traces', '--out', 'out', '--json'],
    exits: [0, 1],
  }),
  'init --source otlp': () => ({
    cwd: projectFrom('init'),
    args: ['init', '--source', `otlp:${otlpFile}`, '--out', 'out', '--json'],
    exits: [0, 1],
  }),
  label: () => {
    const { dir, csv } = labelledProject();
    return { cwd: dir, args: ['label', '--from', csv, '--json'], exits: [0] };
  },
  run: () => ({ cwd: projectFrom('run'), args: ['run', '--json'], exits: [0, 1] }),
  rerun: () => ({ cwd: disputedProject(), args: ['rerun', '--json'], exits: [0, 1] }),
  validate: () => {
    const { dir, csv } = labelledProject();
    expect(runVet(['label', '--from', csv], dir).status).toBe(0);
    return { cwd: dir, args: ['validate', '--json'], exits: [0, 1] };
  },
  estimate: () => ({ cwd: projectFrom('run'), args: ['estimate', '--json'], exits: [0] }),
  check: () => ({ cwd: validatedProject(), args: ['check', '--json'], exits: [0, 1] }),
  'lock refresh': () => ({
    cwd: validatedProject(),
    args: ['lock', 'refresh', '--json'],
    exits: [0, 1],
  }),
  'criteria disable': () => ({
    cwd: projectFrom('run'),
    args: ['criteria', 'disable', 'tone', '--json'],
    exits: [0],
  }),
  'criteria enable': () => {
    const dir = projectFrom('run');
    expect(runVet(['criteria', 'disable', 'tone'], dir).status).toBe(0);
    return { cwd: dir, args: ['criteria', 'enable', 'tone', '--json'], exits: [0] };
  },
  'criteria delete': () => ({
    cwd: projectFrom('run'),
    args: ['criteria', 'delete', 'tone', '--json'],
    exits: [0],
  }),
  'criteria revalidate': () => ({
    cwd: validatedProject(),
    args: ['criteria', 'revalidate', 'tone', '--json'],
    exits: [0],
  }),
  'cases dedupe': () => ({
    cwd: projectFrom('run'),
    args: ['cases', 'dedupe', '--json'],
    exits: [0],
  }),
  'cases quarantine': () => ({
    cwd: projectFrom('run'),
    args: ['cases', 'quarantine', 'case-1', '--reason', 'flaky', '--json'],
    exits: [0],
  }),
  'cases promote': () => ({
    cwd: failedRunProject(),
    args: ['cases', 'promote', 'case-1:tone', '--json'],
    exits: [0],
  }),
  lint: () => ({ cwd: projectFrom('run'), args: ['lint', '--json'], exits: [0, 1] }),
  export: () => ({
    cwd: projectFrom('run'),
    args: ['export', '--to', 'vitest', '--json'],
    exits: [0],
  }),
};

type TestedKey = keyof typeof INVOCATIONS;

function isTestedKey(key: string): key is TestedKey {
  return Object.hasOwn(INVOCATIONS, key);
}

const TESTED_KEYS = Object.keys(INVOCATIONS).filter(isTestedKey);

describe('JSON_SHAPES', () => {
  test.each(TESTED_KEYS)(
    '%s --json document validates',
    (key) => {
      const invocation = INVOCATIONS[key]();
      const result = runVet(invocation.args, invocation.cwd, invocation.env);
      expect(invocation.exits, result.stderr).toContain(result.status);
      // parseJson over the whole of stdout: two documents (or stray text) would not parse.
      const doc = parseJson(result.stdout);
      const checked = validateJson(doc, JSON_SHAPES[key]);
      expect(checked.ok, JSON.stringify(checked.ok ? null : checked.error.cause)).toBe(true);
    },
    90_000,
  );

  test('watch --json document validates', async () => {
    const child = spawn(
      process.execPath,
      [binPath, 'watch', '--port', '0', '--sample', '1', '--json'],
      {
        cwd: projectFrom('watch'),
        env: cleanEnv(),
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    const exited = new Promise<number | null>((resolve) =>
      child.on('exit', (code) => resolve(code)),
    );
    const deadline = Date.now() + 15_000;
    while (!stderr.includes('listening')) {
      if (Date.now() > deadline) throw new Error(`watch never listened: ${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    child.kill('SIGINT');
    expect(await exited).toBe(0);
    const checked = validateJson(parseJson(stdout), JSON_SHAPES.watch);
    expect(checked.ok).toBe(true);
  }, 30_000);

  test('cases review --json in a non-TTY exits 2 with the JSON error document', () => {
    const dir = projectFrom('run');
    const pending = join(dir, 'evals', 'cases', 'pending');
    mkdirSync(pending, { recursive: true });
    const line = {
      id: 'p1',
      input: { state: 'User: hi' },
      traceId: 't1',
      provenance: null,
      tags: [],
    };
    writeFileSync(join(pending, '2026-09-30.jsonl'), `${JSON.stringify(line)}\n`);
    const result = runVet(['cases', 'review', '--json'], dir);
    expect(result.status).toBe(2);
    expect(parseJson(result.stdout)).toMatchObject({
      error: { code: 'NOT_INTERACTIVE', message: expect.any(String) },
    });
  });

  test('cases review --all --json document validates', () => {
    const dir = projectFrom('run');
    const result = runVet(['cases', 'review', '--all', '--json'], dir);
    expect(result.status).toBe(0);
    expect(validateJson(parseJson(result.stdout), JSON_SHAPES['cases review']).ok).toBe(true);
  });

  test('label --from prints {imported, files} and nothing else on stdout', () => {
    const { dir, csv } = labelledProject();
    const result = runVet(['label', '--from', csv, '--json'], dir);
    expect(result.status).toBe(0);
    const doc = parseJson(result.stdout);
    expect(doc).toEqual({
      imported: CASE_COUNT,
      files: [join(dir, 'evals', 'labels', 'tone.csv')],
    });
    expect(result.stdout.trimEnd().split('\n')).toHaveLength(1);
  });

  test('every JSON_SHAPES key ships a schema with a top-level additionalProperties: true and an example that validates', () => {
    for (const [key, schema] of Object.entries(JSON_SHAPES)) {
      expect(schema['additionalProperties'], key).toBe(true);
      expect(schema['$schema'], key).toBe('https://json-schema.org/draft/2020-12/schema');
      const examples: unknown = schema['examples'];
      expect(Array.isArray(examples), key).toBe(true);
      if (!Array.isArray(examples)) continue;
      expect(examples.length, key).toBeGreaterThan(0);
      for (const example of examples) {
        expect(validateJson(example, schema).ok, `${key} example`).toBe(true);
      }
    }
  });
});

// Leaf command paths ("lock refresh"), walking Command.commands recursively.
function leafPaths(command: Command, prefix: string[] = []): string[] {
  return command.commands.flatMap((sub) => {
    const path = [...prefix, sub.name()];
    return sub.commands.length === 0 ? [path.join(' ')] : leafPaths(sub, path);
  });
}

// Commands that existed when the shapes were written. Later commands are covered by their own
// beads; extend this array (and JSON_SHAPES) rather than making the walker closed-world.
const PLAN_TIME_COMMANDS = [
  'doctor',
  'init',
  'label',
  'run',
  'rerun',
  'validate',
  'estimate',
  'check',
  'lock refresh',
  'criteria disable',
  'criteria enable',
  'criteria delete',
  'criteria revalidate',
  'cases dedupe',
  'cases quarantine',
  'cases promote',
  'cases review',
  'lint',
  'export',
  'watch',
];

// Keys that are options or flavours of a command, not commands of their own.
function commandOfKey(key: string): string | undefined {
  if (key === '--version') return undefined;
  return key.replace(/ --source.*$/, '');
}

describe('JSON_SHAPES coverage', () => {
  const registered = new Set(leafPaths(createProgram()));

  test('every registered command or subcommand in createProgram() has a JSON_SHAPES key', () => {
    const keys = Object.keys(JSON_SHAPES);
    for (const command of PLAN_TIME_COMMANDS) {
      expect(registered.has(command), `${command} is registered`).toBe(true);
      expect(
        keys.some((k) => commandOfKey(k) === command),
        `${command} has a shape`,
      ).toBe(true);
    }
  });

  test('every JSON_SHAPES key maps to a registered command', () => {
    for (const key of Object.keys(JSON_SHAPES)) {
      const command = commandOfKey(key);
      if (command === undefined) continue;
      expect(registered.has(command), `${key} -> ${command}`).toBe(true);
    }
  });

  test('renderJsonShapesMarkdown lists every key once', () => {
    const markdown = renderJsonShapesMarkdown();
    const headings = markdown
      .split('\n')
      .filter((line) => line.startsWith('## '))
      .map((line) => line.slice(3).replaceAll('`', '').trim());
    expect(headings.toSorted()).toEqual(Object.keys(JSON_SHAPES).toSorted());
    expect(markdown).toContain('```json');
  });
});
