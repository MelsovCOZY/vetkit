import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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

  // bug (cold gate run 4): exit 1 alone gave no reason on stderr or in --json for why so few
  // criteria survived; this named the count, the minimum, and the dropped/repaired counts.
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

  // `vet init --out <dir>` used to leave <dir> with no vetkit.config.ts, so a
  // `vet run` there always failed CONFIG_INVALID even though criteria.yaml and cases/ were
  // right there at the top level.
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
