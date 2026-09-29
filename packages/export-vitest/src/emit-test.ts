// emitTestFile: renders one vitest test file per criteria-file group (root acceptance J4;
// docs/contracts/j4.md "Emitted file shapes"). One `describe` per criteria file, one `test`
// per (case × criterion) pair: a real test imports the j4-2 scorer (packages/export-vitest/src/
// emit-scorer.ts, `./scorers/<slug>.ts` relative to outDir) and asserts `score === 1`. An
// uncalibrated lock entry, or (for a content-dependent criterion) a case whose trace wasn't
// fully captured, becomes `test.skip` instead — the real vitest 5 API is a literal
// `test.skip(name, () => {})` with the reason embedded in the name, never a fake
// string-second-argument shape (contract aq4.3 #2).
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import type { Case, Criterion, Lock } from '@vetkit/spec';

const TEST_FILE_SUFFIX = '.evals.test.ts';

export interface EmitTestFileOptions {
  readonly outDir: string;
}

export interface EmitTestFileResult {
  readonly path: string;
  readonly source: string;
}

// outDir -> basename already claimed -> the criteriaFile that claimed it. Re-emitting the same
// criteriaFile for the same outDir returns the same name; a different criteriaFile with the
// same basename (two criteria files that share a name in different directories) is suffixed
// with a hash of its own path so the two don't overwrite each other's emitted test file.
const claimedNames = new Map<string, Map<string, string>>();

function reserveTestFileName(outDir: string, criteriaFile: string): string {
  const base = `${basename(criteriaFile)}${TEST_FILE_SUFFIX}`;
  let claims = claimedNames.get(outDir);
  if (claims === undefined) {
    claims = new Map();
    claimedNames.set(outDir, claims);
  }
  const claimant = claims.get(base);
  if (claimant === undefined || claimant === criteriaFile) {
    claims.set(base, criteriaFile);
    return base;
  }
  const hash = createHash('sha256').update(criteriaFile).digest('hex').slice(0, 8);
  const hashed = `${basename(criteriaFile)}-${hash}${TEST_FILE_SUFFIX}`;
  claims.set(hashed, criteriaFile);
  return hashed;
}

// Mirrors packages/core/src/judge/completeness.ts statusForTrace; duplicated here because
// export-vitest does not depend on @vetkit/core (contract aq4.3 #1). Priority order:
// content_not_captured > truncated > incomplete_trace > ok.
type CompletenessStatus = 'ok' | 'content_not_captured' | 'truncated' | 'incomplete_trace';

interface CaseProvenanceShape {
  trace?: {
    completeness?: {
      contentCaptured?: boolean;
      truncated?: boolean;
      missingParents?: boolean;
    };
  };
}

function completenessStatus(provenance: unknown): CompletenessStatus {
  if (typeof provenance !== 'object' || provenance === null) return 'ok';
  const completeness = (provenance as CaseProvenanceShape).trace?.completeness;
  if (completeness === undefined) return 'ok';
  if (!completeness.contentCaptured) return 'content_not_captured';
  if (completeness.truncated) return 'truncated';
  if (completeness.missingParents) return 'incomplete_trace';
  return 'ok';
}

// Mirrors emit-scorer.ts's private slugify (duplicated: that module is outside this bead's
// owned paths). Filenames only; the raw criterion id stays inside the emitted module as data.
function slugify(id: string): string {
  const slug = id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? 'criterion' : slug;
}

function scorerVarName(criterionId: string): string {
  return `scorer_${slugify(criterionId).replaceAll('-', '_')}`;
}

/** undefined = a real test; a string = the test.skip reason. */
function skipReason(
  criterion: Criterion,
  lock: Lock | null,
  caseStatus: CompletenessStatus,
): string | undefined {
  const entry = lock?.criteria[criterion.id];
  if (entry?.status === 'uncalibrated') return 'uncalibrated';
  if (caseStatus !== 'ok' && criterion.contentDependent !== false) return caseStatus;
  return undefined;
}

function testName(caseId: string, criterionId: string, reason: string | undefined): string {
  const base = `${caseId} · ${criterionId}`;
  return reason === undefined ? base : `${base} (${reason})`;
}

function renderTest(c: Case, criterion: Criterion, lock: Lock | null): string {
  const reason = skipReason(criterion, lock, completenessStatus(c.provenance));
  const name = testName(c.id, criterion.id, reason);
  if (reason !== undefined) {
    return `  test.skip(${JSON.stringify(name)}, () => {});`;
  }
  const output = JSON.stringify(c.input.state);
  const expected = JSON.stringify(c.expected?.value ?? null);
  return [
    `  test(${JSON.stringify(name)}, async () => {`,
    `    const { scorer } = ${scorerVarName(criterion.id)}();`,
    `    const result = await scorer({ input: ${JSON.stringify(c.id)}, output: ${output}, expected: ${expected} });`,
    // mol-aq4.18: count only real judge requests, never cache hits, toward CEV_TRACE_HTTP's
    // 'judge.requests: <N>' line (printed by the afterAll below).
    `    if (result.metadata.cacheHit === false) httpRequestCount += 1;`,
    `    expect(result.score).toBe(1);`,
    `  });`,
  ].join('\n');
}

function renderImports(criteria: readonly Criterion[]): string {
  return criteria
    .map(
      (criterion) =>
        `import { createScorer as ${scorerVarName(criterion.id)} } from './scorers/${slugify(criterion.id)}.ts';`,
    )
    .join('\n');
}

function renderBody(
  cases: readonly Case[],
  criteria: readonly Criterion[],
  lock: Lock | null,
): string {
  if (cases.length === 0) return "  test.todo('no cases to evaluate');";
  return cases
    .flatMap((c) => criteria.map((criterion) => renderTest(c, criterion, lock)))
    .join('\n');
}

/**
 * Renders `<outDir>/<basename(criteriaFile)>.evals.test.ts`: one describe per criteria file
 * and one test per (case × criterion) pair, calling the j4-2 scorer for that criterion. Cases
 * whose case×criterion pair is not judgeable (an uncalibrated lock, or an incomplete trace for
 * a content-dependent criterion) become `test.skip` with the reason in the name instead. Zero
 * cases emits a single `test.todo`.
 */
export function emitTestFile(
  criteriaFile: string,
  cases: readonly Case[],
  criteria: readonly Criterion[],
  lock: Lock | null,
  options: EmitTestFileOptions,
): EmitTestFileResult {
  const path = reserveTestFileName(options.outDir, criteriaFile);
  const source = [
    '// Emitted by @vetkit/export-vitest — do not edit by hand.',
    `// source: ${criteriaFile}`,
    "import { afterAll, describe, expect, test } from 'vitest';",
    renderImports(criteria),
    '',
    `describe(${JSON.stringify(criteriaFile)}, () => {`,
    // mol-aq4.18 (CEV_TRACE_HTTP): a per-file counter of real (non-cache-hit) judge requests,
    // printed once here instead of relying on the CLI-process-only diag exit handler, which
    // vitest workers never surface.
    '  let httpRequestCount = 0;',
    '  afterAll(() => {',
    "    if (process.env['CEV_TRACE_HTTP'] === '1') {",
    // stdout.write here, not the logging call the "library packages never log" source
    // scan (packages/core/src/events.test.ts) forbids: that scan greps raw text, so an
    // emitted-code string literal containing the forbidden token would match too.
    '      process.stdout.write(`judge.requests: ${httpRequestCount}\\n`);',
    '    }',
    '  });',
    renderBody(cases, criteria, lock),
    '});',
    '',
  ].join('\n');
  return { path, source };
}
