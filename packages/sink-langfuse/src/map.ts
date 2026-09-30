// Pure Verdict → Langfuse Scores API body (POST /api/public/scores).
// Field names checked 2026-09-28 against langfuse-core@3.39.2 CreateScoreRequest (generated
// from the public OpenAPI spec) and https://langfuse.com/docs/evaluation/scores/overview:
// value is numeric for BOOLEAN (1|0) and NUMERIC, and a string for CATEGORICAL. stringValue is
// NOT a request field (Langfuse fills it from value or a configId), so it is never sent.

import { createRequire } from 'node:module';
import type { Verdict } from '@vetkit/spec';

// Read once at load; the package versions independently, so the marker is its own name@version.
function sinkMarker(): string {
  const name = '@vetkit/sink-langfuse';
  try {
    const pkg: unknown = createRequire(import.meta.url)('../package.json');
    const version =
      typeof pkg === 'object' && pkg !== null
        ? Object.entries(pkg).find(([k]) => k === 'version')?.[1]
        : undefined;
    return typeof version === 'string' && version !== '' ? `${name}@${version}` : name;
  } catch {
    return name;
  }
}

const SINK_MARKER = sinkMarker();

interface LangfuseScoreMetadata {
  model: string;
  transport: string;
  pinned: boolean;
  sink: string;
}

export interface LangfuseScoreBody {
  traceId: string;
  observationId?: string;
  name: string;
  value: number | string;
  dataType: 'BOOLEAN' | 'NUMERIC' | 'CATEGORICAL';
  comment?: string;
  metadata: LangfuseScoreMetadata;
}

// Returns undefined when the verdict carries no scoreable answer.
export function toLangfuseScore(verdict: Verdict, traceId: string): LangfuseScoreBody | undefined {
  const answer = verdict.answer;
  if (answer === undefined) return undefined;
  const base = {
    traceId,
    ...(verdict.provenance?.observationId === undefined
      ? {}
      : { observationId: verdict.provenance.observationId }),
    name: verdict.criterionId,
    metadata: {
      model: verdict.model.resolved || verdict.model.requested,
      transport: verdict.model.transport,
      pinned: verdict.model.pinned,
      sink: SINK_MARKER,
    },
  };
  const comment = verdict.explanation === undefined ? {} : { comment: verdict.explanation };
  if (answer.type === 'boolean') {
    const value = answer.probability >= (verdict.threshold ?? 0.5) ? 1 : 0;
    return { ...base, value, dataType: 'BOOLEAN', ...comment };
  }
  if (answer.type === 'choice') {
    return { ...base, value: answer.choice, dataType: 'CATEGORICAL', ...comment };
  }
  return {
    ...base,
    value: expectedLevel(answer.probabilities, answer.score),
    dataType: 'NUMERIC',
    ...comment,
  };
}

// Σ level·P(level) over numeric level keys; falls back to the judge's score otherwise.
function expectedLevel(probabilities: Record<string, number>, score: number): number {
  const entries = Object.entries(probabilities);
  if (entries.length === 0 || entries.some(([k]) => !Number.isFinite(Number(k)))) return score;
  return entries.reduce((sum, [k, p]) => sum + Number(k) * p, 0);
}
