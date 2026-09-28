// statusForTrace / partitionCases (bead mol-pij.7): turns a normalized trace's completeness
// flags into a typed non-score status, and excludes non-ok cases from content-dependent criteria
// while still judging criteria explicitly marked contentDependent:false (e.g. latency) — root
// acceptance J5, ET brief §4 OTEL-1/3. Never throws: this is data derivation, not validation.

import type { Case, Criterion, NormalizedTrace } from '@vetkit/spec';

// Criterion.contentDependent is not yet in criterion.schema.json (contract pij.7 revision 4); an
// absent flag means true (content-dependent). The schema flag is follow-up work on j1-1.
export type CriterionWithFlag = Criterion & { readonly contentDependent?: boolean };

export type CompletenessStatus = 'ok' | 'content_not_captured' | 'truncated' | 'incomplete_trace';
export type ExclusionStatus = Exclude<CompletenessStatus, 'ok'>;

// The shape j2-5's casesFromTraces is expected to carry on Case.provenance (contract pij.7
// revision 6) — j2-5 does not exist yet, so Case.provenance stays `unknown` at the type level and
// this is read defensively below.
export type CaseTraceProvenance = {
  trace?: { completeness?: NormalizedTrace['completeness'] };
};

export function statusForTrace(trace: {
  completeness?: NormalizedTrace['completeness'];
}): CompletenessStatus {
  const completeness = trace.completeness;
  if (completeness === undefined) return 'ok';
  if (!completeness.contentCaptured) return 'content_not_captured';
  if (completeness.truncated) return 'truncated';
  if (completeness.missingParents) return 'incomplete_trace';
  return 'ok';
}

function readCompleteness(provenance: unknown): NormalizedTrace['completeness'] | undefined {
  if (typeof provenance !== 'object' || provenance === null) return undefined;
  const trace = (provenance as CaseTraceProvenance).trace;
  if (typeof trace !== 'object' || trace === null) return undefined;
  const completeness = trace.completeness;
  if (typeof completeness !== 'object' || completeness === null) return undefined;
  return completeness;
}

export function partitionCases(
  cases: readonly Case[],
  criteria: readonly CriterionWithFlag[],
): {
  judgeable: Array<{ case: Case; criteria: readonly CriterionWithFlag[] }>;
  excluded: Array<{ case: Case; status: ExclusionStatus }>;
} {
  const judgeable: Array<{ case: Case; criteria: readonly CriterionWithFlag[] }> = [];
  const excluded: Array<{ case: Case; status: ExclusionStatus }> = [];

  for (const c of cases) {
    const completeness = readCompleteness(c.provenance);
    const status = statusForTrace(completeness === undefined ? {} : { completeness });
    if (status === 'ok') {
      judgeable.push({ case: c, criteria });
      continue;
    }
    excluded.push({ case: c, status });
    const stillJudgeable = criteria.filter((criterion) => criterion.contentDependent === false);
    if (stillJudgeable.length > 0) judgeable.push({ case: c, criteria: stillJudgeable });
  }

  return { judgeable, excluded };
}
