// Not re-exported from packages/core/src/index.ts: sampler.ts, loop.ts, promote.ts and
// commands/watch.ts import this module by path, as the spec ports are imported directly
// rather than re-barreled.
import type { Case } from '@vetkit/spec';

export interface WatchOptions {
  /** 0..1. Outside that range the CLI throws WATCH_CONFIG. */
  sampleRate: number;
  upstreamSampleRate?: number;
  /** Concurrent judge calls in flight. Default 4. */
  maxInFlight: number;
  /** Default 'fail'. */
  promoteOn: 'fail' | 'never';
  /** Default '.vet/watch/inclusion.jsonl'. */
  inclusionPath: string;
  /** Default 'evals/cases'. Promoted lines are written under `<promotedDir>/pending/`. */
  promotedDir: string;
}

export interface InclusionRecord {
  traceId: string;
  /** ISO 8601. */
  at: string;
  sampled: boolean;
  reason: 'rate' | 'filtered:incomplete' | 'filtered:no_content';
  evaluatorRate: number;
  upstreamRate: number | 'unknown';
  inclusionProbability: number | 'unknown';
}

export interface PromotedCase extends Case {
  // Case['provenance'] is `unknown` (packages/spec/schemas/case.schema.json), so this
  // intersection reduces to the promotedFrom shape alone. It stays an intersection, not a
  // replacement, so it still widens correctly if Case.provenance gains real fields.
  // oxlint-disable-next-line typescript/no-redundant-type-constituents
  provenance: Case['provenance'] & {
    promotedFrom: { traceId: string; criterionId: string; verdictId: string; at: string };
  };
}
