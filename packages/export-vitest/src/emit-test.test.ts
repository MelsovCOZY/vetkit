import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import type { Case, Criterion, Lock, LockCriterion } from '@vetkit/spec';
import { emitScorer } from './emit-scorer.ts';
import { emitTestFile } from './emit-test.ts';

const HASH = 'a'.repeat(64);
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

function booleanCriterion(overrides: Partial<Criterion> = {}): Criterion {
  return {
    id: 'helpful',
    type: 'boolean',
    instructions: 'Is the reply helpful?',
    escape: 'not answerable',
    polarity: 'pass_when_true',
    channel: 'quality',
    provenance: { traceIds: [] },
    wordingHash: HASH,
    ...overrides,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  } as Criterion;
}

function lockEntry(overrides: Partial<LockCriterion> = {}): LockCriterion {
  return {
    wordingHash: HASH,
    status: 'calibrated',
    threshold: 0.6,
    gauntlet: {
      paraphrase: 'pass',
      polarity: 'pass',
      injection: 'pass',
      master_key: 'pass',
      label_permutation: 'pass',
      constant_output: 'pass',
      position_swap: 'pass',
      length: 'pass',
    },
    reasons: [],
    labelCount: 120,
    ...overrides,
  };
}

function lock(entries: Record<string, LockCriterion>): Lock {
  return {
    lockVersion: 1,
    model: { requested: 'fake-judge', resolved: 'fake-judge-v1', transport: 'fake', pinned: true },
    criteria: entries,
    datasetHash: HASH,
  };
}

function makeCase(overrides: Partial<Case> = {}): Case {
  return {
    id: 'c1',
    input: { state: 'the model said hello' },
    provenance: null,
    tags: [],
    ...overrides,
  };
}

function contentNotCapturedProvenance(): unknown {
  return { trace: { completeness: { contentCaptured: false } } };
}

const cleanupDirs: string[] = [];

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshOutDir(): string {
  const dir = mkdtempSync(join(REPO_ROOT, '.vetkit-emit-test-tmp-'));
  cleanupDirs.push(dir);
  return dir;
}

describe('emitTestFile', () => {
  test('zero cases emits a test.todo and no per-case tests', () => {
    const { path, source } = emitTestFile(
      'evals/criteria.yaml',
      [],
      [booleanCriterion()],
      lock({ helpful: lockEntry() }),
      { outDir: freshOutDir() },
    );
    expect(path).toBe('criteria.yaml.evals.test.ts');
    expect(source).toContain('test.todo(');
    expect(source).not.toMatch(/\btest\(/);
  });

  test('an uncalibrated lock entry becomes test.skip with reason uncalibrated', () => {
    const { source } = emitTestFile(
      'evals/criteria.yaml',
      [makeCase()],
      [booleanCriterion()],
      lock({ helpful: lockEntry({ status: 'uncalibrated' }) }),
      { outDir: freshOutDir() },
    );
    expect(source).toContain('test.skip(');
    expect(source).toContain('c1 · helpful (uncalibrated)');
  });

  test('a missing lock entry (no entry for this criterion) runs a real test, not test.skip', () => {
    const { source } = emitTestFile(
      'evals/criteria.yaml',
      [makeCase()],
      [booleanCriterion()],
      lock({}),
      { outDir: freshOutDir() },
    );
    expect(source).toMatch(/test\(['"`]c1 · helpful['"`]/);
    expect(source).not.toContain('test.skip(');
  });

  test('a null lock (no lock file at all) runs a real test, not test.skip', () => {
    const { source } = emitTestFile(
      'evals/criteria.yaml',
      [makeCase()],
      [booleanCriterion()],
      null,
      { outDir: freshOutDir() },
    );
    expect(source).toMatch(/test\(['"`]c1 · helpful['"`]/);
    expect(source).not.toContain('test.skip(');
  });

  test('a content_not_captured case becomes test.skip for a content-dependent criterion', () => {
    const { source } = emitTestFile(
      'evals/criteria.yaml',
      [makeCase({ provenance: contentNotCapturedProvenance() })],
      [booleanCriterion()],
      lock({ helpful: lockEntry() }),
      { outDir: freshOutDir() },
    );
    expect(source).toContain('c1 · helpful (content_not_captured)');
  });

  test('a content_not_captured case still runs a real test when contentDependent is false', () => {
    const { source } = emitTestFile(
      'evals/criteria.yaml',
      [makeCase({ provenance: contentNotCapturedProvenance() })],
      [booleanCriterion({ id: 'latency', contentDependent: false })],
      lock({ latency: lockEntry({ wordingHash: HASH }) }),
      { outDir: freshOutDir() },
    );
    expect(source).not.toContain('c1 · latency (content_not_captured)');
    expect(source).toMatch(/test\(['"`]c1 · latency['"`]/);
  });

  // CEV_TRACE_HTTP=1 prints 'judge.requests: <N>' once per emitted test file, via
  // an afterAll counting real (non-cache-hit) judge requests across its own tests.
  test('emits an afterAll that prints judge.requests only under CEV_TRACE_HTTP', () => {
    const { source } = emitTestFile(
      'evals/criteria.yaml',
      [makeCase()],
      [booleanCriterion()],
      lock({ helpful: lockEntry() }),
      { outDir: freshOutDir() },
    );
    expect(source).toContain('afterAll');
    expect(source).toMatch(/afterAll\([\s\S]*CEV_TRACE_HTTP[\s\S]*judge\.requests/);
    expect(source).toContain("import { afterAll, describe, expect, test } from 'vitest';");
  });

  test('a real test counts a real request, not a cache hit, toward httpRequestCount', () => {
    const { source } = emitTestFile(
      'evals/criteria.yaml',
      [makeCase()],
      [booleanCriterion()],
      lock({ helpful: lockEntry() }),
      { outDir: freshOutDir() },
    );
    expect(source).toContain('httpRequestCount');
    expect(source).toMatch(/cacheHit'?\]?\s*===\s*false/);
  });

  test('zero cases still emits the afterAll (reporting 0), not a crash', () => {
    const { source } = emitTestFile(
      'evals/criteria.yaml',
      [],
      [booleanCriterion()],
      lock({ helpful: lockEntry() }),
      { outDir: freshOutDir() },
    );
    expect(source).toContain('afterAll');
    expect(source).toContain('httpRequestCount');
  });

  test('duplicate basenames are hash-suffixed, stable per criteriaFile path', () => {
    const outDir = freshOutDir();
    const criteria = [booleanCriterion()];
    const l = lock({ helpful: lockEntry() });
    const first = emitTestFile('evals/a/criteria.yaml', [], criteria, l, { outDir });
    const second = emitTestFile('evals/b/criteria.yaml', [], criteria, l, { outDir });
    const secondAgain = emitTestFile('evals/b/criteria.yaml', [], criteria, l, { outDir });
    expect(first.path).toBe('criteria.yaml.evals.test.ts');
    expect(second.path).not.toBe(first.path);
    expect(second.path).toMatch(/^criteria\.yaml-[0-9a-f]{8}\.evals\.test\.ts$/);
    // Re-emitting the same source path returns the same reserved name (idempotent), not a
    // second hash.
    expect(secondAgain.path).toBe(second.path);
  });

  test('compiles the emitted file in a temp dir and asserts the skip reasons', () => {
    const dir = mkdtempSync(join(REPO_ROOT, '.vetkit-emit-test-tsc-'));
    try {
      const helpful = booleanCriterion({ id: 'helpful' });
      const latency = booleanCriterion({ id: 'latency', contentDependent: false });
      const tone = booleanCriterion({ id: 'tone' });
      const criteria = [helpful, latency, tone];
      const l = lock({
        helpful: lockEntry({ wordingHash: HASH }),
        latency: lockEntry({ wordingHash: HASH }),
        // tone has no lock entry: uncalibrated.
      });
      const cases = [
        makeCase({ id: 'c1' }),
        makeCase({ id: 'c2', provenance: contentNotCapturedProvenance() }),
      ];

      mkdirSync(join(dir, 'scorers'), { recursive: true });
      for (const criterion of criteria) {
        const emitted = emitScorer(criterion, l.criteria[criterion.id]);
        writeFileSync(join(dir, emitted.path), emitted.source, 'utf8');
      }

      const { path, source } = emitTestFile('evals/criteria.yaml', cases, criteria, l, {
        outDir: dir,
      });
      expect(source).toContain('c2 · helpful (content_not_captured)');
      expect(source).not.toContain('c2 · latency (content_not_captured)');
      // tone has no lock entry at all: c1 (complete trace) runs for real rather than being
      // skipped as uncalibrated; c2 is still skipped, but for content_not_captured (tone is
      // content-dependent by default), not uncalibrated.
      expect(source).toMatch(/test\(['"`]c1 · tone['"`]/);
      expect(source).toContain('c2 · tone (content_not_captured)');
      writeFileSync(join(dir, path), source, 'utf8');

      const tsconfig = {
        extends: join(REPO_ROOT, 'tsconfig.base.json'),
        compilerOptions: {
          composite: false,
          declaration: true,
          declarationMap: false,
          emitDeclarationOnly: false,
          declarationDir: './.out',
          tsBuildInfoFile: './.out/tsconfig.tsbuildinfo',
          rootDir: REPO_ROOT,
          paths: {
            vetkit: [join(REPO_ROOT, 'packages/cli/src/judge-one.ts')],
            '@vetkit/core': [join(REPO_ROOT, 'packages/core/src/index.ts')],
            '@vetkit/spec': [join(REPO_ROOT, 'packages/spec/src/index.ts')],
            '@vetkit/judge-jev': [join(REPO_ROOT, 'packages/judge-jev/src/index.ts')],
          },
        },
        files: [path],
      };
      writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2), 'utf8');
      const result = spawnSync('bun', ['x', 'tsc', '--noEmit', '-p', 'tsconfig.json'], {
        cwd: dir,
        encoding: 'utf8',
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
