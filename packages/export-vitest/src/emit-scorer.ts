// emitScorer: renders one criterion into an Evalite-compatible vitest scorer module
// (docs/contracts/j4.md "Emitted file shapes"). The emitted module calls the real judge
// through the caller's vetkitPackage at test time; nothing here calls a judge or reads
// process.env, and no fixture or secret is baked into the rendered source.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  CEV_ERROR_CODES,
  criterionSchema,
  validateJson,
  VetError,
  type Criterion,
  type LockCriterion,
} from '@vetkit/spec';

const require = createRequire(import.meta.url);
const TEMPLATE_PATH = fileURLToPath(new URL('./templates/scorer.ts.tmpl', import.meta.url));
const DEFAULT_THRESHOLD = 0.5;
const DEFAULT_VETKIT_PACKAGE = 'vetkit';

function readVersion(): string {
  const pkgJson: { version: string } = require('../package.json');
  return pkgJson.version;
}

function invalid(message: string): VetError {
  return new VetError(CEV_ERROR_CODES.CRITERIA_INVALID, message);
}

// Filenames only: unsafe characters become `-`; the raw id stays inside the module as data.
function slugify(id: string): string {
  const slug = id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? 'criterion' : slug;
}

// Only ever JSON.stringify'd (the embedded JudgeOneCriterion literal), so the precise
// discriminated-union typing of Criterion is not worth reconstructing after the spread.
function withoutWordingHash(criterion: Criterion): unknown {
  const { wordingHash: _wordingHash, ...rest } = criterion;
  return rest;
}

export interface EmitScorerOptions {
  /** The import specifier the emitted module reaches judgeOne through. Default 'vetkit'. */
  readonly vetkitPackage?: string;
}

export interface EmitScorerResult {
  readonly path: string;
  readonly source: string;
}

/** Renders `<outDir>/scorers/<criterionId>.ts` for one criterion; never fails on an uncalibrated lock. */
export function emitScorer(
  criterion: Criterion,
  lock: LockCriterion | undefined,
  options: EmitScorerOptions = {},
): EmitScorerResult {
  const result = validateJson<Criterion>(criterion, criterionSchema);
  if (!result.ok) throw invalid(`invalid criterion: ${result.error.message}`);

  const vetkitPackage = options.vetkitPackage ?? DEFAULT_VETKIT_PACKAGE;
  const threshold = lock?.threshold ?? DEFAULT_THRESHOLD;
  const status = lock?.status ?? 'uncalibrated';
  const judgeOneCriterion = withoutWordingHash(result.value);
  const template = readFileSync(TEMPLATE_PATH, 'utf8');
  const source = template
    .replaceAll('{{version}}', readVersion())
    .replaceAll('{{criterionId}}', criterion.id)
    .replaceAll('{{wordingHash}}', criterion.wordingHash)
    .replaceAll('{{status}}', status)
    .replaceAll('{{threshold}}', String(threshold))
    .replaceAll('{{tolerance}}', String(lock?.tolerance ?? 0))
    .replaceAll('{{vetkitPackage}}', vetkitPackage)
    .replaceAll('{{criterionJson}}', JSON.stringify(judgeOneCriterion, null, 2));

  return { path: `scorers/${slugify(criterion.id)}.ts`, source };
}
