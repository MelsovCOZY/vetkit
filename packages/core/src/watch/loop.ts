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
import type { Case, SinkV1, SourceV1, Verdict } from '@vetkit/spec';
import { extractCases } from '../generate/cases.ts';
import { createLimiter } from '../judge/pacing.ts';
import type { Outbox } from '../outbox/outbox.ts';
import type { Sampler } from './sampler.ts';
import type { WatchOptions } from './types.ts';

/** One judged case in, one Verdict per criterion out. Bound to criteria + a JudgeV1 by the
 * caller (dh8.3): the loop itself never sees criteria, only this callable. */
export interface JudgeCaseFn {
  (input: { readonly case: Case; readonly signal: AbortSignal }): Promise<Verdict[]>;
}

export interface RunWatchOptions extends WatchOptions {
  /** Per judge call. RISK (brief 6): whole-call deadlines are mandatory. Default 30_000. */
  readonly judgeTimeoutMs?: number;
}

export interface RunWatchInput {
  readonly source: SourceV1;
  readonly sampler: Sampler;
  readonly judge: JudgeCaseFn;
  readonly outbox: Outbox;
  readonly sinks: readonly SinkV1[];
  readonly options: RunWatchOptions;
  readonly signal: AbortSignal;
  /** dh8.3's promotion hook, called once per enqueued verdict. Returning `true` counts it
   * toward `promoted`. */
  readonly onVerdict?: (verdict: Verdict) => boolean | void;
}

export interface CoverageSummary {
  readonly seen: number;
  readonly sampled: number;
  readonly judged: number;
  readonly promoted: number;
  readonly produced: number;
  readonly acknowledged: number;
}

const DEFAULT_JUDGE_TIMEOUT_MS = 30_000;
const DRAIN_INTERVAL_MS = 2000;
const DRAIN_PENDING_THRESHOLD = 50;

function causeOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Edge case: "Judge throws → catch, produce a Verdict with status 'infra_failure' and cause,
 * enqueue, continue." One sentinel verdict per failed case: the loop has no criterion ids to
 * attribute the failure to (those live behind the opaque `judge` callable). */
function infraFailureVerdict(caseId: string, cause: string): Verdict {
  return {
    caseId,
    criterionId: '*',
    status: 'infra_failure',
    model: { requested: 'unknown', resolved: 'unknown', transport: 'unknown', pinned: false },
    cacheHit: false,
    cause,
  };
}

export async function runWatch(input: RunWatchInput): Promise<CoverageSummary> {
  const { source, sampler, judge, outbox, sinks, options, signal, onVerdict } = input;
  const judgeTimeoutMs = options.judgeTimeoutMs ?? DEFAULT_JUDGE_TIMEOUT_MS;
  const limiter = createLimiter({ maxInFlight: options.maxInFlight });

  let seen = 0;
  let sampled = 0;
  let judged = 0;
  let promoted = 0;
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

  async function judgeOne(evalCase: Case): Promise<void> {
    const perCall = AbortSignal.any([signal, AbortSignal.timeout(judgeTimeoutMs)]);
    let verdicts: Verdict[];
    try {
      verdicts = await limiter.run(() => judge({ case: evalCase, signal: perCall }), {
        signal: perCall,
      });
    } catch (err) {
      // Edge case: "Abort during a judge call → the in-flight call is aborted via the signal,
      // its verdict is 'infra_failure:aborted' and NOT enqueued (nothing to write back)."
      if (perCall.aborted) return;
      verdicts = [infraFailureVerdict(evalCase.id, causeOf(err))];
    }
    judged += 1;
    await serializeOutbox(() => outbox.enqueue(verdicts));
    pendingSinceDrain += verdicts.length;
    for (const v of verdicts) {
      if (onVerdict?.(v) === true) promoted += 1;
    }
    if (pendingSinceDrain >= DRAIN_PENDING_THRESHOLD) void drainOnce();
  }

  const timer = setInterval(() => void drainOnce(), DRAIN_INTERVAL_MS);
  timer.unref();

  let sourceError: unknown;
  try {
    for await (const trace of source.doRead({ signal })) {
      if (signal.aborted) break;
      seen += 1;
      const { sampled: isSampled } = sampler.decide(trace);
      if (!isSampled) continue;
      sampled += 1;

      // oxlint-disable-next-line no-await-in-loop
      await acquireSlot();
      const { cases } = extractCases({ traces: [trace], criteria: [] });
      const evalCase = cases[0];
      if (evalCase === undefined) {
        // Excluded by statusForTrace (content_not_captured/truncated/incomplete_trace) or
        // no_conversation: nothing to judge for this trace.
        releaseSlot();
        continue;
      }
      const task = judgeOne(evalCase).finally(releaseSlot);
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
  await drainOnce();

  if (sourceError !== undefined) throw sourceError;

  const reconciled = await outbox.reconcile();
  return {
    seen,
    sampled,
    judged,
    promoted,
    produced: reconciled.produced,
    acknowledged: reconciled.acknowledged,
  };
}
