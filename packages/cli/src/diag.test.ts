import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeParseJson, type JudgeV1 } from '@vetkit/spec';
import { beforeAll, describe, expect, test } from 'vitest';
import { countJudgeRequests, diagEnabled, formatDiagLine } from './diag.ts';
import { ensureCliBuilt } from './test-support/build-cli.js';

// mol-0nw.24: CEV_DIAG=1 makes `vet run` report how many judge requests actually went out.

const binPath = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
const fixtureDir = fileURLToPath(new URL('../../../fixtures/cli/run', import.meta.url));

const fakeJudge: JudgeV1 = {
  specVersion: 'v1',
  id: 'fake',
  capabilities: {
    questionTypes: ['boolean'],
    maxStateTokens: 100,
    pinned: true,
    transport: 'inline',
    model: 'm',
  },
  doJudge: () =>
    Promise.resolve({
      answers: {},
      model: { requested: 'm', resolved: 'm', transport: 'inline', pinned: true },
    }),
};

const REQUEST = {
  state: 's',
  questions: { q: { type: 'boolean', instructions: 'is it?' } },
} as const;

describe('diag helpers', () => {
  test('diagEnabled is true only for CEV_DIAG=1', () => {
    expect(diagEnabled({ CEV_DIAG: '1' })).toBe(true);
    expect(diagEnabled({})).toBe(false);
    expect(diagEnabled({ CEV_DIAG: '0' })).toBe(false);
  });

  test('countJudgeRequests counts each doJudge call and passes the response through', async () => {
    let calls = 0;
    const judge = countJudgeRequests(fakeJudge, () => {
      calls += 1;
    });
    const response = await judge.doJudge(REQUEST);
    await judge.doJudge(REQUEST);
    expect(calls).toBe(2);
    expect(response.model.resolved).toBe('m');
    expect(judge.id).toBe('fake');
    expect(judge.capabilities).toBe(fakeJudge.capabilities);
  });

  test('formatDiagLine is one {"diag":{"judge":{"requests":N}}} line', () => {
    expect(formatDiagLine(3)).toBe('{"diag":{"judge":{"requests":3}}}\n');
  });
});

const CASE_COUNT = 3;

// A private copy of the `vet run` fixture with CASE_COUNT cases and one shared cache dir.
function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vetkit-diag-'));
  cpSync(fixtureDir, dir, { recursive: true });
  const cases = join(dir, 'evals/cases/cases.jsonl');
  for (let i = 2; i <= CASE_COUNT; i += 1) {
    appendFileSync(
      cases,
      `${JSON.stringify({ id: `case-${String(i)}`, input: { state: `User: hi ${String(i)}` }, provenance: null, tags: [] })}\n`,
    );
  }
  return dir;
}

function runVet(cwd: string, extra: Record<string, string>) {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', VETKIT_FIXTURE_MODE: 'pass' };
  delete env.CEV_DIAG;
  return spawnSync(process.execPath, [binPath, 'run', '--json'], {
    cwd,
    env: { ...env, ...extra },
    encoding: 'utf8',
  });
}

function diagLines(stderr: string): string[] {
  return stderr.split('\n').filter((line) => line.includes('"diag"'));
}

function expectOneJsonDocument(stdout: string): void {
  expect(stdout.trim().split('\n')).toHaveLength(1);
  expect(safeParseJson<unknown>(stdout, {}).ok).toBe(true);
  expect(stdout).not.toContain('diag');
}

describe('vet run with CEV_DIAG=1', () => {
  beforeAll(async () => {
    await ensureCliBuilt();
  }, 180_000);

  test('a first run reports one judge request per case; a cached rerun reports 0', () => {
    const cwd = project();
    const first = runVet(cwd, { CEV_DIAG: '1' });
    expect(first.status).toBe(0);
    expectOneJsonDocument(first.stdout);
    expect(diagLines(first.stderr)).toEqual([
      `{"diag":{"judge":{"requests":${String(CASE_COUNT)}}}}`,
    ]);
    const lines = first.stderr.trimEnd().split('\n');
    expect(lines.at(-1)).toBe(`{"diag":{"judge":{"requests":${String(CASE_COUNT)}}}}`);

    const second = runVet(cwd, { CEV_DIAG: '1' });
    expect(second.status).toBe(0);
    expectOneJsonDocument(second.stdout);
    expect(diagLines(second.stderr)).toEqual(['{"diag":{"judge":{"requests":0}}}']);
  });

  test('without CEV_DIAG no diag line is printed', () => {
    const result = runVet(project(), {});
    expect(result.status).toBe(0);
    expectOneJsonDocument(result.stdout);
    expect(diagLines(result.stderr)).toEqual([]);
  });
});
