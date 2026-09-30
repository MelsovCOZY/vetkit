// Judge pacing: one shared, adaptive (AIMD) in-flight limiter for run, validate and watch.
// The transport never sleeps; it surfaces `details.retryable` / `details.retryAfterMs` on
// VetError and this limiter owns every wait.
//
// A retryable failure sets a shared `pausedUntil` that gates ALL acquisitions, halves the
// ceiling (min 1), releases the failing call's slot and re-queues it. Ten consecutive
// successes grow the ceiling by one up to `maxInFlight`. The retry budget is per run() call,
// measured from its first attempt. JUDGE_TIMEOUT carries no details, so it is not retried.
// One wake timer exists only while something is both paused and queued; it stays ref'd
// because it is the sole thing a real CLI process is waiting on during a
// backoff — an unref'd timer lets Node see no remaining work and exit(0) mid-retry,
// before the timer ever fires, abandoning the run with no output.

import { VetError } from '@vetkit/spec';

export type PacingEvent =
  | { readonly type: 'judge.throttled'; readonly retryAfterMs: number; readonly ceiling: number }
  | { readonly type: 'judge.retry'; readonly attempt: number };

export interface LimiterOptions {
  readonly maxInFlight?: number;
  readonly maxRetries?: number;
  readonly totalBudgetMs?: number;
  readonly maxBackoffMs?: number;
  /** Ceiling on a server-suggested (Retry-After) wait; larger values are clamped, not rejected. */
  readonly maxRetryAfterMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly random?: () => number;
  readonly emit?: (event: PacingEvent) => void;
}

export interface LimiterStats {
  readonly inFlight: number;
  readonly ceiling: number;
  readonly queued: number;
  readonly pausedUntil: number;
  readonly retries: number;
  readonly throttles: number;
}

export interface Limiter {
  run<T>(fn: () => Promise<T>, options?: { readonly signal?: AbortSignal }): Promise<T>;
  stats(): LimiterStats;
}

interface Waiter {
  readonly grant: () => void;
  readonly detach: () => void;
}

const RECOVERY_STREAK = 10;
const MIN_BACKOFF_MS = 250;

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(
      () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      },
      Math.max(0, ms),
    );
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function limiterError(last: VetError, attempts: number, extra?: string): VetError {
  const suffix = extra === undefined ? '' : ` — ${extra}`;
  const options = { cause: { error: last, attempts } };
  return new VetError(
    last.code,
    `${last.message}${suffix} (after ${attempts} attempts)`,
    last.details === undefined ? options : { ...options, details: last.details },
  );
}

// A connection-level failure (details.hint set: ECONNREFUSED, DNS, reset — never a plain
// HTTP 429/5xx, which carries retryAfterMs/no hint) means the endpoint itself is unreachable,
// not merely asking for patience; retrying it on the full AIMD backoff (up to maxBackoffMs,
// maxRetries) can run for minutes for something that will not resolve in that window. It
// gets a short, fixed retry budget instead, but still exhausts as JUDGE_UNAVAILABLE with its
// hint intact via limiterError, like any other retryable failure; JUDGE_TIMEOUT stays
// reserved for a real deadline.
const NETWORK_UNREACHABLE_MAX_RETRIES = 2;
const NETWORK_UNREACHABLE_MAX_BACKOFF_MS = 2_000;

function isNetworkUnreachable(error: VetError): boolean {
  return error.details?.hint !== undefined;
}

export function createLimiter(opts: LimiterOptions = {}): Limiter {
  const maxInFlight = opts.maxInFlight ?? 4;
  const maxRetries = opts.maxRetries ?? 6;
  const totalBudgetMs = opts.totalBudgetMs ?? 300_000;
  const maxBackoffMs = opts.maxBackoffMs ?? 40_000;
  const maxRetryAfterMs = opts.maxRetryAfterMs ?? 120_000;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;
  const emit = opts.emit ?? ((): void => {});

  let ceiling = maxInFlight;
  let inFlight = 0;
  let pausedUntil = 0;
  let retries = 0;
  let throttles = 0;
  let streak = 0;
  const queue: Waiter[] = [];
  let wake: AbortController | undefined;

  function cancelWake(): void {
    wake?.abort();
    wake = undefined;
  }

  function pump(): void {
    // One clock read per pump: a second read could pass the pause between the check and the
    // sleep, giving a negative delay or a wake timer that is never armed.
    let t = now();
    while (queue.length > 0 && inFlight < ceiling && t >= pausedUntil) {
      const waiter = queue.shift();
      if (waiter === undefined) break;
      waiter.detach();
      inFlight += 1;
      waiter.grant();
      t = now();
    }
    if (queue.length === 0) {
      cancelWake();
      return;
    }
    if (wake === undefined && t < pausedUntil) {
      const controller = new AbortController();
      wake = controller;
      sleep(Math.max(0, pausedUntil - t), controller.signal).then(
        () => {
          if (wake === controller) wake = undefined;
          pump();
        },
        () => {},
      );
    }
  }

  function acquire(signal: AbortSignal | undefined): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(signal.reason);
        return;
      }
      const onAbort = (): void => {
        const i = queue.indexOf(waiter);
        if (i !== -1) queue.splice(i, 1);
        reject(signal?.reason);
        if (queue.length === 0) cancelWake();
      };
      const waiter: Waiter = {
        grant: resolve,
        detach: () => signal?.removeEventListener('abort', onAbort),
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      queue.push(waiter);
      pump();
    });
  }

  function release(): void {
    inFlight -= 1;
    pump();
  }

  async function run<T>(
    fn: () => Promise<T>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<T> {
    const signal = options?.signal;
    let start: number | undefined;
    let attempts = 0;
    for (;;) {
      await acquire(signal);
      start ??= now();
      attempts += 1;
      let error: unknown;
      try {
        const value = await fn();
        streak += 1;
        if (streak >= RECOVERY_STREAK) {
          streak = 0;
          if (ceiling < maxInFlight) ceiling += 1;
        }
        release();
        return value;
      } catch (caught) {
        error = caught;
      }
      if (!VetError.isInstance(error)) {
        release();
        throw error;
      }
      if (error.details?.retryable !== true) {
        release();
        throw limiterError(error, attempts);
      }
      const networkUnreachable = isNetworkUnreachable(error);
      const effectiveMaxRetries = networkUnreachable
        ? Math.min(maxRetries, NETWORK_UNREACHABLE_MAX_RETRIES)
        : maxRetries;
      if (attempts > effectiveMaxRetries) {
        release();
        throw limiterError(error, attempts);
      }
      const effectiveMaxBackoffMs = networkUnreachable
        ? Math.min(maxBackoffMs, NETWORK_UNREACHABLE_MAX_BACKOFF_MS)
        : maxBackoffMs;
      // A usable header wait is positive and finite (garbage, zero or past values fall back to
      // backoff) and is clamped to maxRetryAfterMs; the backoff never drops below MIN_BACKOFF_MS.
      const suggested = error.details.retryAfterMs;
      const wait =
        suggested !== undefined && Number.isFinite(suggested) && suggested > 0
          ? Math.min(suggested, maxRetryAfterMs)
          : Math.max(
              MIN_BACKOFF_MS,
              random() * Math.min(effectiveMaxBackoffMs, 1000 * 2 ** attempts),
            );
      const remaining = totalBudgetMs - (now() - start);
      if (wait > remaining) {
        release();
        throw limiterError(error, attempts, `retry budget exhausted (suggested wait ${wait}ms)`);
      }
      streak = 0;
      pausedUntil = Math.max(pausedUntil, now() + wait);
      ceiling = Math.max(1, Math.floor(ceiling / 2));
      throttles += 1;
      retries += 1;
      emit({ type: 'judge.throttled', retryAfterMs: wait, ceiling });
      emit({ type: 'judge.retry', attempt: attempts + 1 });
      release();
    }
  }

  return {
    run,
    stats: () => ({ inFlight, ceiling, queued: queue.length, pausedUntil, retries, throttles }),
  };
}
