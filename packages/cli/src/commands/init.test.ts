import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeParseJson } from '@vetkit/spec';
import { beforeAll, describe, expect, test } from 'vitest';
import { ensureCliBuilt } from '../test-support/build-cli.js';

const binPath = fileURLToPath(new URL('../../dist/bin.js', import.meta.url));
const fixtureDir = fileURLToPath(new URL('../../../../fixtures/cli/init/', import.meta.url));

beforeAll(async () => {
  await ensureCliBuilt();
}, 180_000);

interface Result {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number | null;
  readonly pid: number;
}

// A private copy of the fixture project per test, so nothing is written under fixtures/.
function freshProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vetkit-init-'));
  cpSync(fixtureDir, dir, { recursive: true });
  return dir;
}

function runVet(
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Result {
  return spawnSync(process.execPath, [binPath, ...args], { cwd, env, encoding: 'utf8' });
}

interface GenerateDoc {
  readonly criteria: readonly unknown[];
  readonly cases: readonly unknown[];
  readonly report: { readonly status: string };
  readonly reason?: string;
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters
function parseJson<T>(text: string): T {
  const result = safeParseJson<T>(text, {});
  if (!result.ok) throw result.error;
  return result.value;
}

describe('vet init --source', () => {
  test('--json prints one {criteria, cases, report} document and exits 0 when >= 5 criteria survive', () => {
    const project = freshProject();
    const out = join(project, 'evals-out');
    const result = runVet(['init', '--source', 'traces', '--out', out, '--json'], project);
    expect(result.status).toBe(0);
    const doc = parseJson<GenerateDoc>(result.stdout);
    expect(doc.report.status).toBe('ok');
    expect(doc.criteria.length).toBeGreaterThanOrEqual(5);
    expect(existsSync(join(out, 'criteria.yaml'))).toBe(true);
    expect(existsSync(join(out, 'cases', 'generated.jsonl'))).toBe(true);
  });

  test('exits 1 when fewer than 5 criteria survive', () => {
    const project = freshProject();
    const out = join(project, 'evals-out');
    const result = runVet(['init', '--source', 'traces', '--out', out, '--json'], project, {
      ...process.env,
      VETKIT_FIXTURE_MODE: 'few',
    });
    expect(result.status).toBe(1);
    const doc = parseJson<GenerateDoc>(result.stdout);
    expect(doc.report.status).toBe('ok');
    expect(doc.criteria.length).toBeLessThan(5);
  });

  // The reason for a too-few-criteria exit 1 shows on stderr and in --json: the count, the
  // minimum, and the dropped/repaired counts.
  test('exits 1 with a stderr reason naming the count, the minimum and the dropped/repaired counts', () => {
    const project = freshProject();
    const out = join(project, 'evals-out');
    const result = runVet(['init', '--source', 'traces', '--out', out, '--json'], project, {
      ...process.env,
      VETKIT_FIXTURE_MODE: 'few',
    });
    expect(result.status).toBe(1);
    const doc = parseJson<GenerateDoc>(result.stdout);
    expect(doc.reason).toBe(
      'only 2 criteria survived generation, need at least 5 (dropped 0, repaired 0)',
    );
    expect(result.stderr).toContain(doc.reason);
  });

  test('a jsonl: prefix resolves the same traces directory as a bare path', () => {
    const project = freshProject();
    const out = join(project, 'evals-out');
    const result = runVet(['init', '--source', 'jsonl:traces', '--out', out, '--json'], project);
    expect(result.status).toBe(0);
    const doc = parseJson<GenerateDoc>(result.stdout);
    expect(doc.criteria.length).toBeGreaterThanOrEqual(5);
  });

  test('a missing --source path exits 2 naming SOURCE_UNREADABLE', () => {
    const project = freshProject();
    const out = join(project, 'evals-out');
    const result = runVet(['init', '--source', 'no-such-dir', '--out', out], project);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('SOURCE_UNREADABLE');
  });

  test('--out existing and non-empty without --force exits 2 CONFIG_INVALID naming the directory', () => {
    const project = freshProject();
    const out = join(project, 'evals-out');
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'stray.txt'), 'x');
    const result = runVet(['init', '--source', 'traces', '--out', out], project);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('CONFIG_INVALID');
    expect(result.stderr).toContain(out);
    // The pre-existing directory is untouched: no generation was attempted.
    expect(existsSync(join(out, 'stray.txt'))).toBe(true);
  });

  test('--out existing and non-empty with --force replaces it', () => {
    const project = freshProject();
    const out = join(project, 'evals-out');
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'stray.txt'), 'x');
    const result = runVet(
      ['init', '--source', 'traces', '--out', out, '--force', '--json'],
      project,
    );
    expect(result.status).toBe(0);
    expect(existsSync(join(out, 'stray.txt'))).toBe(false);
    expect(existsSync(join(out, 'criteria.yaml'))).toBe(true);
  });

  test('no temp sibling directory is left behind next to --out on success', () => {
    const project = freshProject();
    const out = join(project, 'evals-out');
    const result = runVet(['init', '--source', 'traces', '--out', out, '--json'], project);
    expect(result.status).toBe(0);
    // The CLI process's own pid names its temp dir; the spawned child's pid is `result.pid`.
    expect(existsSync(`${out}.tmp-${String(result.pid)}`)).toBe(false);
  });

  // `vet init --out <dir>` writes a vetkit.config.ts, so `vet run` there does not fail
  // CONFIG_INVALID even though criteria.yaml and cases/ sit at the top level.
  test('--out writes a vetkit.config.ts that a `vet run` in that directory can load every case with', () => {
    const project = freshProject();
    const out = join(project, 'evals-out');
    const initResult = runVet(['init', '--source', 'traces', '--out', out, '--json'], project);
    expect(initResult.status).toBe(0);
    const initDoc = parseJson<GenerateDoc>(initResult.stdout);
    expect(existsSync(join(out, 'vetkit.config.ts'))).toBe(true);

    const runResult = runVet(['run', '--json'], out);
    expect(runResult.stderr).not.toContain('CONFIG_INVALID');
    expect(runResult.status).not.toBe(2);
    const runDoc = parseJson<{ summary: { total: number } }>(runResult.stdout);
    expect(runDoc.summary.total).toBe(initDoc.cases.length);
  });
});

interface GeneratorTotals {
  readonly calls: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly estimatedUsd: number | null;
}

interface MeteredDoc {
  readonly generator: GeneratorTotals;
}

const PRICE_IN = 'CEV_GENERATOR_PRICE_INPUT_PER_MTOK';
const PRICE_OUT = 'CEV_GENERATOR_PRICE_OUTPUT_PER_MTOK';
const REPORTED_RETURN = "return { value, resolvedModelId: 'fake-generator-resolved' };";

// The fixture generator reports no usage; a private config copy can make it report a fixed one.
function projectWithGeneratorUsage(usage: boolean): string {
  const project = freshProject();
  if (usage) {
    const file = join(project, 'vetkit.config.ts');
    const text = readFileSync(file, 'utf8');
    expect(text).toContain(REPORTED_RETURN);
    writeFileSync(
      file,
      text.replace(
        REPORTED_RETURN,
        "return { value, resolvedModelId: 'fake-generator-resolved', usage: { inputTokens: 10, outputTokens: 4 } };",
      ),
    );
  }
  return project;
}

function metered(project: string, env: NodeJS.ProcessEnv): Result {
  const out = join(project, 'evals-out');
  return runVet(['init', '--source', 'traces', '--out', out, '--json'], project, {
    ...process.env,
    CEV_DIAG: undefined,
    CEV_TRACE_HTTP: undefined,
    [PRICE_IN]: undefined,
    [PRICE_OUT]: undefined,
    ...env,
  });
}

function diagGenerator(stderr: string): GeneratorTotals | undefined {
  for (const line of stderr.split('\n')) {
    if (!line.startsWith('{"diag"')) continue;
    const parsed = parseJson<{ diag: { generator?: GeneratorTotals } }>(line);
    if (parsed.diag.generator !== undefined) return parsed.diag.generator;
  }
  return undefined;
}

describe('vet init --source generator usage', () => {
  test('usage from every generator call is summed into --json generator totals', () => {
    const result = metered(projectWithGeneratorUsage(true), {});
    expect(result.status).toBe(0);
    const { generator } = parseJson<MeteredDoc>(result.stdout);
    expect(generator.calls).toBeGreaterThanOrEqual(2);
    expect(generator.inputTokens).toBe(generator.calls * 10);
    expect(generator.outputTokens).toBe(generator.calls * 4);
    expect(generator.estimatedUsd).toBeNull();
  });

  test('a generator without usage still counts calls and reports null tokens', () => {
    const result = metered(projectWithGeneratorUsage(false), {});
    expect(result.status).toBe(0);
    const { generator } = parseJson<MeteredDoc>(result.stdout);
    expect(generator.calls).toBeGreaterThanOrEqual(2);
    expect(generator.inputTokens).toBeNull();
    expect(generator.outputTokens).toBeNull();
    expect(generator.estimatedUsd).toBeNull();
  });

  test('estimatedUsd prices the totals when both per-million-token env prices are set', () => {
    const result = metered(projectWithGeneratorUsage(true), { [PRICE_IN]: '2', [PRICE_OUT]: '8' });
    const { generator } = parseJson<MeteredDoc>(result.stdout);
    const expected = ((generator.calls * 10 * 2) + (generator.calls * 4 * 8)) / 1_000_000;
    expect(generator.estimatedUsd).toBeCloseTo(expected, 12);
  });

  test('estimatedUsd stays null when only one price is set', () => {
    const result = metered(projectWithGeneratorUsage(true), { [PRICE_IN]: '2' });
    const { generator } = parseJson<MeteredDoc>(result.stdout);
    expect(generator.estimatedUsd).toBeNull();
  });

  test('a negative or non-numeric price is ignored with a warning naming the variable, never its value', () => {
    const result = metered(projectWithGeneratorUsage(true), {
      [PRICE_IN]: 'abc-secret',
      [PRICE_OUT]: '-31337',
    });
    expect(result.status).toBe(0);
    const { generator } = parseJson<MeteredDoc>(result.stdout);
    expect(generator.estimatedUsd).toBeNull();
    expect(result.stderr).toContain(PRICE_IN);
    expect(result.stderr).toContain(PRICE_OUT);
    expect(result.stderr).not.toContain('abc-secret');
    expect(result.stderr).not.toContain('-31337');
  });

  test('CEV_DIAG=1 writes the same generator totals as a stderr diag line; without it no such line', () => {
    const project = projectWithGeneratorUsage(true);
    const withDiag = metered(project, { CEV_DIAG: '1' });
    const { generator } = parseJson<MeteredDoc>(withDiag.stdout);
    expect(generator.calls).toBeGreaterThanOrEqual(2);
    expect(diagGenerator(withDiag.stderr)).toEqual(generator);

    const without = metered(projectWithGeneratorUsage(true), {});
    expect(diagGenerator(without.stderr)).toBeUndefined();
  });

  test('init --help mentions the two price env vars', () => {
    const result = runVet(['init', '--help'], freshProject());
    expect(result.stdout).toContain(PRICE_IN);
    expect(result.stdout).toContain(PRICE_OUT);
  });

  test('CEV_DIAG=1 still writes the generator diag line once when generation throws after a success', () => {
    const project = projectWithGeneratorUsage(true);
    const file = join(project, 'vetkit.config.ts');
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace(
        'async doGenerate(req: GenerateRequest) {',
        "async doGenerate(req: GenerateRequest) {\n    fixtureCalls += 1;\n    if (fixtureCalls > 1) throw new Error('generator exploded');",
      ).replace('const generator = {', 'let fixtureCalls = 0;\nconst generator = {'),
    );
    const result = metered(project, { CEV_DIAG: '1' });
    expect(result.status).toBe(70);
    const lines = result.stderr.split('\n').filter((l) => l.startsWith('{"diag":{"generator"'));
    expect(lines).toHaveLength(1);
    expect(diagGenerator(result.stderr)).toMatchObject({
      calls: 2,
      inputTokens: 10,
      outputTokens: 4,
    });
  });
});
