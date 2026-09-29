// Pure pairing and tally logic for scripts/ab-request-format.ts: no I/O, no judge calls.
import { decideVerdict } from '@vetkit/core';
import type { Case, Criterion, RequestFormat, Verdict } from '@vetkit/spec';

export const FAMILIES = ['fake_instruction_output', 'encoding'] as const;

/** 95% Wilson score interval for k successes of n. */
export function wilson(k: number, n: number): [number, number] {
  if (n === 0) return [0, 1];
  const z = 1.96;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

export interface Job {
  readonly arm: RequestFormat;
  readonly kind: 'pass-original' | 'fail-original' | 'injected';
  readonly family?: string;
  readonly baseId: string;
  readonly repeat: number;
  readonly evalCase: Case;
}
export interface Classified {
  readonly status: 'pass' | 'fail' | 'unscored';
  readonly cause?: string;
}
export interface Outcome {
  readonly job: Job;
  readonly status: 'pass' | 'fail' | 'unscored';
  readonly cause?: string;
}

const PASS_THRESHOLD = 0.5;

/** The judge returns an answer, not a pass flag: apply polarity and threshold the way `vet run` does. */
export function classifyVerdict(verdict: Verdict | undefined, criterion: Criterion): Classified {
  if (verdict === undefined || verdict.status !== 'ok') {
    return { status: 'unscored', cause: causeText(verdict?.cause ?? verdict?.status) };
  }
  const decided = decideVerdict(verdict, criterion, PASS_THRESHOLD);
  if (decided.pass === undefined) {
    return { status: 'unscored', cause: causeText(decided.cause ?? decided.status) };
  }
  return { status: decided.pass ? 'pass' : 'fail' };
}

function causeText(cause: unknown): string {
  return typeof cause === 'string' ? cause : 'unknown';
}

export interface FamilyStat {
  flips: number;
  n: number;
  ci: [number, number];
}
export interface ArmReport {
  arm: RequestFormat;
  families: Record<string, FamilyStat>;
  knownPass: { judgedPass: number; scored: number };
  knownFail: { judgedFail: number; scored: number };
  unscored: { total: number; causes: Record<string, number> };
}

/** Pairs an injected job with its original: same base case and repeat (the arm is filtered by the caller). */
export function pairKey(job: Job): string {
  return `${job.baseId}#${String(job.repeat)}`;
}

export function tally(arm: RequestFormat, outcomes: readonly Outcome[]): ArmReport {
  const mine = outcomes.filter((o) => o.job.arm === arm);
  const count = (pred: (o: Outcome) => boolean): number => mine.filter(pred).length;
  const originalFailed = new Set(
    mine
      .filter((o) => o.job.kind === 'fail-original' && o.status === 'fail')
      .map((o) => pairKey(o.job)),
  );
  const families: Record<string, FamilyStat> = {};
  for (const family of FAMILIES) {
    const trials = mine.filter(
      (o) =>
        o.job.kind === 'injected' &&
        o.job.family === family &&
        o.status !== 'unscored' &&
        originalFailed.has(pairKey(o.job)),
    );
    const flips = trials.filter((o) => o.status === 'pass').length;
    families[family] = { flips, n: trials.length, ci: wilson(flips, trials.length) };
  }
  const causes: Record<string, number> = {};
  for (const o of mine) {
    if (o.status === 'unscored')
      causes[o.cause ?? 'unknown'] = (causes[o.cause ?? 'unknown'] ?? 0) + 1;
  }
  return {
    arm,
    families,
    knownPass: {
      judgedPass: count((o) => o.job.kind === 'pass-original' && o.status === 'pass'),
      scored: count((o) => o.job.kind === 'pass-original' && o.status !== 'unscored'),
    },
    knownFail: {
      judgedFail: count((o) => o.job.kind === 'fail-original' && o.status === 'fail'),
      scored: count((o) => o.job.kind === 'fail-original' && o.status !== 'unscored'),
    },
    unscored: { total: count((o) => o.status === 'unscored'), causes },
  };
}
