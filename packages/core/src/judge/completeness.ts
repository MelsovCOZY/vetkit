// statusForTrace / partitionCases: turns a normalized trace's completeness
// flags into a typed non-score status, and excludes non-ok cases from content-dependent criteria
// while still judging criteria explicitly marked contentDependent:false (e.g. latency).
// Never throws: this is data derivation, not validation.

import type { Case, Criterion, NormalizedTrace } from '@vetkit/spec';

export type CompletenessStatus = 'ok' | 'content_not_captured' | 'truncated' | 'incomplete_trace';
export type ExclusionStatus = Exclude<CompletenessStatus, 'ok'>;

// The shape casesFromTraces carries on Case.provenance. Case.provenance is `unknown` at the
// type level, so it is read defensively below.
type CaseTraceProvenance = {
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
  criteria: readonly Criterion[],
): {
  judgeable: Array<{ case: Case; criteria: readonly Criterion[] }>;
  excluded: Array<{ case: Case; status: ExclusionStatus }>;
} {
  const judgeable: Array<{ case: Case; criteria: readonly Criterion[] }> = [];
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
