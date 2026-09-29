// runWatch: drives the J5 receiver stream through the sampler, the judge and the unsampled
// outbox (docs/contracts/j7.md "Sampling rule" / "Inclusion log"; bead classified-evals-mol-dh8.2,
// Approach + Edge cases). OUT of scope: sampler internals (dh8.1), promotion (dh8.3, hooked in
// here only via the `onVerdict` callback), CLI rendering.
//
// `judge` is the only judging surface this module touches (design: "no new judge or sink logic"):
// the case built from each trace and any doJudge/request-building live behind that callable,
// bound to real criteria + a JudgeV1 by the caller (dh8.3).
//
// Concurrency is bounded twice, deliberately: an owned semaphore caps how many traces are between
// "sampled" and "judged" at once, so a for-await over a stream that may never end (the receiver)
// never buffers unboundedly (RISK note); `judge` itself is invoked through the shared J1 pacing
// limiter (judge/pacing.ts) so watch, run and validate pace against the same Retry-After state
// (UX brief C1).
import {
  VetError,
  type Case,
  type Criterion,
  type SinkV1,
  type SourceV1,
  type Verdict,
} from '@vetkit/spec';
import { extractCases } from '../generate/cases.ts';
import { partitionCases, type ExclusionStatus } from '../judge/completeness.ts';
import { createLimiter } from '../judge/pacing.ts';
import type { Outbox } from '../outbox/outbox.ts';
import type { Sampler } from './sampler.ts';
import type { WatchOptions } from './types.ts';

/** One judged case in, one Verdict per criterion out. `criteria` is already the judgeable
 * subset for this case (bead classified-evals-mol-dh8.4: `partitionCases` has already excluded
 * content-dependent criteria for a non-ok trace). Bound to a JudgeV1 by the caller (dh8.3). */
export interface JudgeCaseFn {
  (input: {
    readonly case: Case;
    readonly criteria: readonly Criterion[];
    readonly signal: AbortSignal;
  }): Promise<Verdict[]>;
}

export interface RunWatchOptions extends WatchOptions {
  /** Per judge call. RISK (brief 6): whole-call deadlines are mandatory. Default 30_000. */
  readonly judgeTimeoutMs?: number;
  /** Deadline for the final outbox drain, independent of any abort signal (bug dh8.8).
   * Default 30_000. */
  readonly drainTimeoutMs?: number;
}

export interface RunWatchInput {
  readonly source: SourceV1;
  readonly sampler: Sampler;
  readonly judge: JudgeCaseFn;
  readonly criteria: readonly Criterion[];
  readonly outbox: Outbox;
  readonly sinks: readonly SinkV1[];
  readonly options: RunWatchOptions;
  readonly signal: AbortSignal;
  /** Graceful stop (first SIGINT, bug dh8.8): the source is told to end, but everything it
   * had already accepted is still recorded, judged (if sampled) and drained; in-flight judge
   * calls are NOT aborted. `signal` stays the hard abort. */
  readonly stop?: AbortSignal;
  /** dh8.3's promotion hook, called once per enqueued verdict with the Case it was judged
   * against. `verdict.id` is exactly the id `outbox.enqueue` assigned it (bug dh8.5: enqueue
   * assigns each verdict's id to a copy it builds internally, so the bare Verdict this loop
   * judges never carries it — this hook is handed the corrected copy instead). Returning
   * `true` counts it toward `promoted`. */
  readonly onVerdict?: (verdict: Verdict, evalCase: Case) => boolean | void;
}

export interface CoverageSummary {
  readonly seen: number;
  readonly sampled: number;
  /** Sampled cases the judge answered (no verdict came back status 'unscored' or
   * 'infra_failure'; a thrown judge is recorded as infra_failure and counted under `unscored`). */
  readonly judged: number;
  /** Sampled cases with at least one status 'unscored' verdict (judge outage: failures may be missed). */
  readonly unscored: number;
  /** Distinct cause codes (never messages or bodies) behind `unscored`, sorted. */
  readonly unscoredCauses: string[];
  readonly promoted: number;
  readonly produced: number;
  readonly acknowledged: number;
  /** Cases excluded from (full or partial) judging by completeness status (root DECISION,
   * dh8.4): a case can be counted here and still be judged, on its content-independent
   * criteria only — see `partitionCases`. */
  readonly excluded: Record<ExclusionStatus, number>;
}

const DEFAULT_JUDGE_TIMEOUT_MS = 30_000;
const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;
const DRAIN_INTERVAL_MS = 2000;
const DRAIN_PENDING_THRESHOLD = 50;

const CODE_SHAPE = /^[A-Z][A-Z0-9_]*$/;

/** Code of a verdict cause: a bare code string or `{code}`; anything else is 'UNKNOWN', so a
 * free-text message never reaches the summary. */
function causeCode(cause: unknown): string {
  const code =
    typeof cause === 'string' ? cause : isRecord(cause) ? (cause as { code?: unknown }).code : '';
  return typeof code === 'string' && CODE_SHAPE.test(code) ? code : 'UNKNOWN';
}

/** Cause of a thrown judge: the CevError code if present, else JUDGE_UNAVAILABLE; never the
 * raw message (dh8.10). */
function thrownCause(err: unknown): { readonly code: string } {
  return { code: VetError.isInstance(err) ? err.code : 'JUDGE_UNAVAILABLE' };
}

const PROV_KEYS = [
  'traceId',
  'spanId',
  'responseId',
  'observationId',
  'dialect',
  'schemaUrl',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Same shape run.ts's private verdictProvenance() builds for `vet run` (picks the six
// verdict-provenance schema keys off the case's provenance, case.traceId winning): duplicated
// here rather than imported, since exporting it would mean touching run.ts/index.ts, which
// aren't owned by this bead (dh8.7, same duplication as commands/watch.ts's caseProvenance).
function caseProvenance(evalCase: Case): Verdict['provenance'] | undefined {
  const source = isRecord(evalCase.provenance) ? evalCase.provenance : {};
  const out: NonNullable<Verdict['provenance']> = {};
  for (const key of PROV_KEYS) {
    const value = source[key];
    if (typeof value === 'string') out[key] = value;
  }
  if (evalCase.traceId !== undefined) out.traceId = evalCase.traceId;
  return Object.keys(out).length === 0 ? undefined : out;
}

/** Edge case: "Judge throws → catch, produce a Verdict with status 'infra_failure' and cause,
 * enqueue, continue." One sentinel verdict per failed case: the loop has no criterion ids to
 * attribute the failure to (those live behind the opaque `judge` callable). */
// enqueue() assigns each verdict's id to a copy it builds internally ({...v, id}), never
// mutating the array this loop already has in hand — so a caller-supplied id is kept, and
// only a missing one is backfilled from what enqueue reports back for that same position.
function withAssignedId(v: Verdict, id: string | undefined): Verdict {
  if (v.id !== undefined || id === undefined) return v;
  return { ...v, id };
}

function infraFailureVerdict(
  caseId: string,
  cause: { readonly code: string },
  provenance: Verdict['provenance'],
): Verdict {
  return {
    caseId,
    criterionId: '*',
    status: 'infra_failure',
    model: { requested: 'unknown', resolved: 'unknown', transport: 'unknown', pinned: false },
    cacheHit: false,
    cause,
    ...(provenance === undefined ? {} : { provenance }),
  };
}

export async function runWatch(input: RunWatchInput): Promise<CoverageSummary> {
  const { source, sampler, judge, criteria, outbox, sinks, options, signal, stop, onVerdict } =
    input;
  const judgeTimeoutMs = options.judgeTimeoutMs ?? DEFAULT_JUDGE_TIMEOUT_MS;
  const limiter = createLimiter({ maxInFlight: options.maxInFlight });

  let seen = 0;
  let sampled = 0;
  let judged = 0;
  let unscored = 0;
  const unscoredCauses = new Set<string>();
  let promoted = 0;
  const excluded: Record<ExclusionStatus, number> = {
    content_not_captured: 0,
    truncated: 0,
    incomplete_trace: 0,
  };
  let pendingSinceDrain = 0;
  let draining: Promise<void> | undefined;
  const tasks = new Set<Promise<void>>();

  // The real outbox is a single-writer-per-directory file lock (withLock), not reentrant within
  // a process: concurrent enqueue()/drain() calls from separate in-flight judge tasks collide on
  // its `.lock` file. Every outbox call this loop makes is funneled through one chain so they
  // never overlap, independent of how many judge calls run concurrently.
  let outboxChain: Promise<void> = Promise.resolve();
  function serializeOutbox<T>(fn: () => Promise<T>): Promise<T> {
    const run = outboxChain.then(fn, fn);
    outboxChain = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  // Own semaphore (Approach: "acquire semaphore"): bounds how many traces are between "sampled"
  // and "judged" at once, so the for-await pull below applies real backpressure.
  let activeSlots = 0;
  const waiters: Array<() => void> = [];
  function acquireSlot(): Promise<void> {
    if (activeSlots < options.maxInFlight) {
      activeSlots += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      waiters.push(() => {
        activeSlots += 1;
        resolve();
      });
    });
  }
  function releaseSlot(): void {
    activeSlots -= 1;
    const next = waiters.shift();
    if (next !== undefined) next();
  }

  function drainOnce(): Promise<void> {
    if (draining !== undefined) return draining;
    pendingSinceDrain = 0;
    draining = serializeOutbox(() => outbox.drain(sinks))
      .then(() => {})
      .finally(() => {
        draining = undefined;
      });
    return draining;
  }

  async function judgeOne(evalCase: Case, caseCriteria: readonly Criterion[]): Promise<void> {
    const perCall = AbortSignal.any([signal, AbortSignal.timeout(judgeTimeoutMs)]);
    let verdicts: Verdict[];
    try {
      verdicts = await limiter.run(
        () => judge({ case: evalCase, criteria: caseCriteria, signal: perCall }),
        { signal: perCall },
      );
    } catch (err) {
      // Edge case: "Abort during a judge call → the in-flight call is aborted via the signal,
      // its verdict is 'infra_failure:aborted' and NOT enqueued (nothing to write back)."
      if (perCall.aborted) return;
      verdicts = [infraFailureVerdict(evalCase.id, thrownCause(err), caseProvenance(evalCase))];
    }
    const failed = verdicts.filter((v) => v.status === 'unscored' || v.status === 'infra_failure');
    if (failed.length === 0) {
      judged += 1;
    } else {
      unscored += 1;
      for (const v of failed) unscoredCauses.add(causeCode(v.cause));
    }
    const ids = await serializeOutbox(() => outbox.enqueue(verdicts));
    const withIds = verdicts.map((v, i) => withAssignedId(v, ids[i]));
    pendingSinceDrain += withIds.length;
    for (const v of withIds) {
      if (onVerdict?.(v, evalCase) === true) promoted += 1;
    }
    if (pendingSinceDrain >= DRAIN_PENDING_THRESHOLD) void drainOnce();
  }

  // The final drain gets its own deadline (never the aborted signal): a wedged sink cannot
  // hold the process past it, and reconcile() below then reports what was acknowledged.
  async function boundedFinalDrain(): Promise<void> {
    let deadline: NodeJS.Timeout | undefined;
    const expired = new Promise<void>((resolve) => {
      deadline = setTimeout(resolve, options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS);
    });
    try {
      await Promise.race([drainOnce().catch(() => {}), expired]);
    } finally {
      clearTimeout(deadline);
    }
  }

  const timer = setInterval(() => void drainOnce(), DRAIN_INTERVAL_MS);
  timer.unref();

  let sourceError: unknown;
  try {
    const readSignal = stop === undefined ? signal : AbortSignal.any([signal, stop]);
    for await (const trace of source.doRead({ signal: readSignal })) {
      if (signal.aborted) break;
      seen += 1;
      const { sampled: isSampled } = sampler.decide(trace);
      if (!isSampled) continue;
      sampled += 1;

      // oxlint-disable-next-line no-await-in-loop
      await acquireSlot();
      // includeIncomplete: true (dh8.4) — a truncated/incomplete trace with a real conversation
      // still becomes a Case (with completeness-carrying provenance), so partitionCases below
      // can select its content-independent criteria instead of the whole trace being dropped.
      const { cases } = extractCases({ traces: [trace], criteria, includeIncomplete: true });
      const evalCase = cases[0];
      if (evalCase === undefined) {
        // No conversation at all (or content_not_captured with no messages): nothing to judge.
        releaseSlot();
        continue;
      }
      const { judgeable, excluded: excludedHere } = partitionCases([evalCase], criteria);
      for (const e of excludedHere) excluded[e.status] += 1;
      const entry = judgeable[0];
      if (entry === undefined || entry.criteria.length === 0) {
        // Excluded, and no content-independent criteria left to judge it on.
        releaseSlot();
        continue;
      }
      const task = judgeOne(entry.case, entry.criteria).finally(releaseSlot);
      tasks.add(task);
      void task.finally(() => tasks.delete(task));
    }
  } catch (err) {
    if (!signal.aborted) sourceError = err;
  } finally {
    clearInterval(timer);
  }

  await Promise.allSettled(tasks);
  // Edge case: "the FIRST SIGINT drains the outbox once" — the same single drain-once call
  // covers both a natural end and an abort-driven end of the source stream.
  await boundedFinalDrain();

  if (sourceError !== undefined) throw sourceError;

  const reconciled = await outbox.reconcile();
  return {
    seen,
    sampled,
    judged,
    unscored,
    unscoredCauses: [...unscoredCauses].toSorted(),
    promoted,
    produced: reconciled.produced,
    acknowledged: reconciled.acknowledged,
    excluded,
  };
}
