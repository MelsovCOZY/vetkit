// judgeOne: one criterion over one state, for emitted vitest scorers (mol-aq4.8). It loads the
// user's vetkit.config.* through the shared loader (the judge is built here in the CLI, never in
// core), then runs core judgeCase with the same file cache `vet run` uses (config cacheDir).
import { resolve } from 'node:path';
import { computeWordingHash, createFileCache, judgeCase } from '@vetkit/core';
import {
  CEV_ERROR_CODES,
  criterionSchema,
  validateJson,
  VetError,
  type Case,
  type Criterion,
  type Verdict,
} from '@vetkit/spec';
import { loadVetConfig } from './config-load.ts';

type Env = Readonly<Record<string, string | undefined>>;

type DeepReadonly<T> = T extends readonly unknown[] | Record<string, unknown>
  ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
  : T;
type WithoutHash<T> = T extends unknown ? DeepReadonly<Omit<T, 'wordingHash'>> : never;

/** A criterion as written in criteria.yaml (literals and `as const` welcome); wordingHash is computed here. */
export type JudgeOneCriterion = WithoutHash<Criterion>;

export interface JudgeOneInput {
  readonly criterion: JudgeOneCriterion;
  /** The judged content (Case.input.state). */
  readonly state: string;
}

export interface JudgeOneOptions {
  /** Explicit config file; relative paths resolve against cwd. */
  readonly configPath?: string;
  /** Directory searched for vetkit.config.*. Defaults to process.cwd(). */
  readonly cwd?: string;
  /** Where judge credential env vars are read. Defaults to process.env. */
  readonly env?: Env;
  readonly signal?: AbortSignal;
}

const CASE_ID = 'judge-one';
const PLACEHOLDER_HASH = '0'.repeat(64);

function invalid(message: string): VetError {
  return new VetError(CEV_ERROR_CODES.CRITERIA_INVALID, message);
}

function toCriterion(input: JudgeOneCriterion): Criterion {
  // The schema requires a wordingHash; a placeholder passes it, then the real one replaces it.
  const result = validateJson<Criterion>(
    { ...input, wordingHash: PLACEHOLDER_HASH },
    criterionSchema,
  );
  if (!result.ok) throw invalid(`invalid criterion: ${result.error.message}`);
  const v = result.value;
  // Same wording subset as loadCriteria's hash (and lock.ts wordingOf), so cache keys match.
  const wordingHash = computeWordingHash({
    type: v.type,
    instructions: v.instructions,
    ...(v.criteria === undefined ? {} : { criteria: v.criteria }),
    ...(v.escape === undefined ? {} : { escape: v.escape }),
  });
  const criterion: Criterion = { ...v, wordingHash };
  if (criterion.type === 'choice') {
    const missing = criterion.passWhen.filter((value) => !Object.hasOwn(criterion.criteria, value));
    if (missing.length > 0) {
      throw invalid(
        `criterion '${criterion.id}': passWhen value '${missing.join("', '")}' is not a key of its criteria map`,
      );
    }
  }
  return criterion;
}

/** Judges one criterion over one state; rejects CRITERIA_INVALID or CONFIG_INVALID (VetError). */
export async function judgeOne(
  input: JudgeOneInput,
  options: JudgeOneOptions = {},
): Promise<Verdict> {
  const criterion = toCriterion(input.criterion);
  const loaded = await loadVetConfig({
    cwd: options.cwd ?? process.cwd(),
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  const evalCase: Case = { id: CASE_ID, input: { state: input.state }, provenance: null, tags: [] };
  const [verdict] = await judgeCase({
    judge: loaded.judge,
    case: evalCase,
    criteria: [criterion],
    cache: createFileCache(resolve(loaded.rootDir, loaded.config.cacheDir)),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (verdict === undefined) throw new VetError(CEV_ERROR_CODES.JUDGE_BAD_RESPONSE, 'no verdict');
  return verdict;
}
