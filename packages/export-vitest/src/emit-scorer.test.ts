import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import type { Criterion, LockCriterion, Verdict } from '@vetkit/spec';
import { emitScorer } from './emit-scorer.ts';

const HASH = 'a'.repeat(64);
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
// node_modules/vetkit (the devDependency symlink) lives under the package root, not the
// repo root, so a real bare-specifier import must sit somewhere resolution walks through
// it. The runtime-behavior tests below avoid that path entirely (see emitAndLoad): they
// point `vetkitPackage` at a stub sibling module instead of building the whole workspace
// just to load the real judgeOne, which is never called once `__judge` is supplied.
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

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

function choiceCriterion(overrides: Partial<Criterion> = {}): Criterion {
  return {
    id: 'tone',
    type: 'choice',
    instructions: 'Which tone best describes the reply?',
    escape: 'unclear',
    criteria: { formal: 'Formal tone', casual: 'Casual tone', unclear: 'Cannot tell' },
    passWhen: ['formal'],
    polarity: 'pass_when_true',
    channel: 'quality',
    provenance: { traceIds: [] },
    wordingHash: HASH,
    ...overrides,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  } as Criterion;
}

function scoreCriterion(overrides: Partial<Criterion> = {}): Criterion {
  return {
    id: 'clarity',
    type: 'score',
    instructions: 'Rate clarity from 0 to 3.',
    criteria: ['poor', 'fair', 'good', 'excellent'],
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

const MODEL: Verdict['model'] = {
  requested: 'fake-judge',
  resolved: 'fake-judge-v1',
  transport: 'fake',
  pinned: true,
};

function okVerdict(criterionId: string, answer: NonNullable<Verdict['answer']>): Verdict {
  return { caseId: 'judge-one', criterionId, status: 'ok', answer, model: MODEL, cacheHit: false };
}

function booleanJudge(probability: number): () => Promise<Verdict> {
  return async () => okVerdict('helpful', { type: 'boolean', probability });
}

function badVerdict(criterionId: string, status: Verdict['status'], cause?: unknown): Verdict {
  return {
    caseId: 'judge-one',
    criterionId,
    status,
    model: MODEL,
    cacheHit: false,
    ...(cause === undefined ? {} : { cause }),
  };
}

interface EmittedModule {
  createScorer: (overrides?: { __judge?: (...args: unknown[]) => Promise<Verdict> }) => {
    name: string;
    scorer: (input: { input: string; output: string; expected?: unknown }) => Promise<{
      score: number;
      metadata: Record<string, unknown>;
    }>;
  };
}

const STUB_VETKIT_SPECIFIER = './stub-judge.ts';
const STUB_VETKIT_SOURCE = `export async function judgeOne() {
  throw new Error('stub judgeOne must not be called; every test supplies __judge');
}
`;

const cleanupDirs: string[] = [];

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Emits the scorer with vetkitPackage pointed at a throwaway stub (never called, since
 * every test supplies `__judge`), writes it beside the stub in a fresh temp dir under the
 * package root (so relative resolution needs no workspace build), and imports it live.
 */
async function emitAndLoad(
  criterion: Criterion,
  lock: LockCriterion | undefined,
): Promise<{ path: string; source: string; mod: EmittedModule }> {
  const emitted = emitScorer(criterion, lock, { vetkitPackage: STUB_VETKIT_SPECIFIER });
  const dir = mkdtempSync(join(PACKAGE_ROOT, '.vetkit-scorer-tmp-'));
  cleanupDirs.push(dir);
  writeFileSync(join(dir, 'stub-judge.ts'), STUB_VETKIT_SOURCE, 'utf8');
  const file = join(dir, 'scorer.ts');
  writeFileSync(file, emitted.source, 'utf8');
  const mod: unknown = await import(pathToFileURL(file).href);
  return {
    path: emitted.path,
    source: emitted.source,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    mod: mod as EmittedModule,
  };
}

function typecheck(source: string): { status: number | null; output: string } {
  const dir = mkdtempSync(join(REPO_ROOT, '.vetkit-scorer-tsc-'));
  writeFileSync(join(dir, 'scorer.ts'), source, 'utf8');
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
      // Every workspace package is source-only in this check (no dist/ built yet), so each
      // bare specifier judgeOne's own import graph reaches is source-path-mapped, the same
      // way the package's own tsconfig.json maps 'vetkit' and '@vetkit/spec' pre-build.
      paths: {
        vetkit: [join(REPO_ROOT, 'packages/cli/src/judge-one.ts')],
        '@vetkit/core': [join(REPO_ROOT, 'packages/core/src/index.ts')],
        '@vetkit/spec': [join(REPO_ROOT, 'packages/spec/src/index.ts')],
        '@vetkit/judge-jev': [join(REPO_ROOT, 'packages/judge-jev/src/index.ts')],
      },
    },
    files: ['scorer.ts'],
  };
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2), 'utf8');
  const result = spawnSync('bun', ['x', 'tsc', '--noEmit', '-p', 'tsconfig.json'], {
    cwd: dir,
    encoding: 'utf8',
  });
  rmSync(dir, { recursive: true, force: true });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

describe('emitScorer', () => {
  test('emits a module that type-checks against the real judgeOne types', () => {
    const { source } = emitScorer(booleanCriterion(), lockEntry());
    const { status, output } = typecheck(source);
    expect(status, output).toBe(0);
  }, 60_000);

  test('header carries no AI_GATEWAY_API_KEY or apiKey substring', () => {
    const { source } = emitScorer(booleanCriterion(), lockEntry());
    expect(source).not.toContain('AI_GATEWAY_API_KEY');
    expect(source).not.toContain('apiKey');
  });

  test('slugifies unsafe ids for the filename while keeping the raw id inside the module', () => {
    const { path, source } = emitScorer(
      booleanCriterion({ id: 'Has Spaces/And:Colons' }),
      lockEntry(),
    );
    expect(path).toBe('scorers/has-spaces-and-colons.ts');
    expect(source).toContain('Has Spaces/And:Colons');
  });

  test('defaults threshold 0.5 and status uncalibrated when the lock is absent', async () => {
    const { mod } = await emitAndLoad(booleanCriterion(), undefined);
    const { scorer } = mod.createScorer({
      __judge: async () => okVerdict('helpful', { type: 'boolean', probability: 0.5 }),
    });
    const result = await scorer({ input: 'q', output: 'a' });
    expect(result.metadata['threshold']).toBe(0.5);
    expect(result.metadata['status']).toBe('uncalibrated');
  });

  test('keeps a calibrated lock status and threshold', async () => {
    const { mod } = await emitAndLoad(
      booleanCriterion(),
      lockEntry({ status: 'calibrated', threshold: 0.6 }),
    );
    const { scorer } = mod.createScorer({
      __judge: async () => okVerdict('helpful', { type: 'boolean', probability: 0.9 }),
    });
    const result = await scorer({ input: 'q', output: 'a' });
    expect(result.metadata['status']).toBe('calibrated');
    expect(result.metadata['threshold']).toBe(0.6);
  });

  test('keeps a floating lock status', async () => {
    const { mod } = await emitAndLoad(
      booleanCriterion(),
      lockEntry({ status: 'floating', threshold: 0.6 }),
    );
    const { scorer } = mod.createScorer({
      __judge: async () => okVerdict('helpful', { type: 'boolean', probability: 0.9 }),
    });
    const result = await scorer({ input: 'q', output: 'a' });
    expect(result.metadata['status']).toBe('floating');
  });

  test('boolean pass_when_true: score 1 at/above threshold, 0 below', async () => {
    const { mod } = await emitAndLoad(booleanCriterion(), lockEntry({ threshold: 0.6 }));
    const above = await mod
      .createScorer({ __judge: booleanJudge(0.6) })
      .scorer({ input: '', output: '' });
    const below = await mod
      .createScorer({ __judge: booleanJudge(0.59) })
      .scorer({ input: '', output: '' });
    expect(above.score).toBe(1);
    expect(below.score).toBe(0);
    expect(above.metadata['probability']).toBe(0.6);
  });

  test('boolean pass_when_false inverts the pass value', async () => {
    const { mod } = await emitAndLoad(
      booleanCriterion({ polarity: 'pass_when_false' }),
      lockEntry({ threshold: 0.6 }),
    );
    // 1 - 0.2 = 0.8 >= 0.6 -> pass
    const result = await mod
      .createScorer({ __judge: booleanJudge(0.2) })
      .scorer({ input: '', output: '' });
    expect(result.score).toBe(1);
  });

  test('choice pass_when_true: score derives from the summed passWhen probability', async () => {
    const { mod } = await emitAndLoad(choiceCriterion(), lockEntry({ threshold: 0.6 }));
    const answer = {
      type: 'choice' as const,
      choice: 'formal',
      confidence: 0.9,
      probabilities: { formal: 0.7, casual: 0.2, unclear: 0.1 },
    };
    const result = await mod
      .createScorer({ __judge: async () => okVerdict('tone', answer) })
      .scorer({ input: '', output: '' });
    expect(result.score).toBe(1);
    expect(result.metadata['status']).toBe('calibrated');
  });

  test('choice pass_when_false inverts the summed passWhen probability', async () => {
    const { mod } = await emitAndLoad(
      choiceCriterion({ polarity: 'pass_when_false' }),
      lockEntry({ threshold: 0.6 }),
    );
    const answer = {
      type: 'choice' as const,
      choice: 'casual',
      confidence: 0.9,
      probabilities: { formal: 0.1, casual: 0.8, unclear: 0.1 },
    };
    // pPass(formal) = 0.1, inverted = 0.9 >= 0.6 -> pass
    const result = await mod
      .createScorer({ __judge: async () => okVerdict('tone', answer) })
      .scorer({ input: '', output: '' });
    expect(result.score).toBe(1);
  });

  test('score criterion: expected level from probabilities compared to the threshold', async () => {
    const { mod } = await emitAndLoad(scoreCriterion(), lockEntry({ threshold: 2 }));
    const answer = {
      type: 'score' as const,
      score: 3,
      confidence: 0.9,
      legend: {},
      probabilities: { '0': 0, '1': 0, '2': 0.1, '3': 0.9 },
    };
    // expected = 2*0.1 + 3*0.9 = 2.9 >= 2 -> pass
    const result = await mod
      .createScorer({ __judge: async () => okVerdict('clarity', answer) })
      .scorer({ input: '', output: '' });
    expect(result.score).toBe(1);
  });

  test('score criterion falls back to the raw score field when probabilities is empty', async () => {
    const { mod } = await emitAndLoad(scoreCriterion(), lockEntry({ threshold: 2 }));
    const answer = {
      type: 'score' as const,
      score: 1,
      confidence: 0.9,
      legend: {},
      probabilities: {},
    };
    const result = await mod
      .createScorer({ __judge: async () => okVerdict('clarity', answer) })
      .scorer({ input: '', output: '' });
    expect(result.score).toBe(0);
  });

  test('score criterion pass_when_false inverts against the level ceiling', async () => {
    const { mod } = await emitAndLoad(
      scoreCriterion({ polarity: 'pass_when_false' }),
      lockEntry({ threshold: 2 }),
    );
    // levels - 1 - expected = 3 - 0 = 3 >= 2 -> pass
    const answer = {
      type: 'score' as const,
      score: 0,
      confidence: 0.9,
      legend: {},
      probabilities: {},
    };
    const result = await mod
      .createScorer({ __judge: async () => okVerdict('clarity', answer) })
      .scorer({ input: '', output: '' });
    expect(result.score).toBe(1);
  });

  test('boolean escape (choice-shaped answer) is not a pass and status reflects the escape', async () => {
    const { mod } = await emitAndLoad(booleanCriterion(), lockEntry({ threshold: 0.1 }));
    const answer = {
      type: 'choice' as const,
      choice: 'escape',
      confidence: 0.9,
      probabilities: { yes: 0.05, no: 0.05, escape: 0.9 },
    };
    const result = await mod
      .createScorer({ __judge: async () => okVerdict('helpful', answer) })
      .scorer({ input: '', output: '' });
    expect(result.score).toBe(0);
    expect(result.metadata['status']).toBe('not_applicable');
  });

  test('choice escape is not a pass and status reflects the escape', async () => {
    const { mod } = await emitAndLoad(choiceCriterion(), lockEntry({ threshold: 0.1 }));
    const answer = {
      type: 'choice' as const,
      choice: 'unclear',
      confidence: 0.9,
      probabilities: { formal: 0.05, casual: 0.05, unclear: 0.9 },
    };
    const result = await mod
      .createScorer({ __judge: async () => okVerdict('tone', answer) })
      .scorer({ input: '', output: '' });
    expect(result.score).toBe(0);
    expect(result.metadata['status']).toBe('not_applicable');
  });

  test('throws (never scores 0 silently) when judgeOne returns a non-ok status', async () => {
    const { mod } = await emitAndLoad(booleanCriterion(), lockEntry());
    const { scorer } = mod.createScorer({
      __judge: async () => badVerdict('helpful', 'content_not_captured', 'trace missing'),
    });
    await expect(scorer({ input: '', output: '' })).rejects.toMatchObject({
      status: 'content_not_captured',
      cause: 'trace missing',
    });
  });

  test('throws when judgeOne returns ok status but no answer', async () => {
    const { mod } = await emitAndLoad(booleanCriterion(), lockEntry());
    const { scorer } = mod.createScorer({
      __judge: async () => ({
        caseId: 'judge-one',
        criterionId: 'helpful',
        status: 'ok',
        model: MODEL,
        cacheHit: false,
      }),
    });
    await expect(scorer({ input: '', output: '' })).rejects.toThrow();
  });

  test('throws CRITERIA_INVALID for a malformed criterion', () => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    expect(() => emitScorer({ id: 'bad' } as Criterion, undefined)).toThrow(
      expect.objectContaining({ code: 'CRITERIA_INVALID' }),
    );
  });
});
