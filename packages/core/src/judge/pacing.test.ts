import { afterEach, describe, expect, it, vi } from 'vitest';
import { VetError } from '@vetkit/spec';
import { createLimiter, type PacingEvent } from './pacing.ts';

// All tests drive the limiter through an injected virtual clock (`now` + `sleep`), so no real
// time passes; 'no pending timers when idle' uses the defaults under vi.useFakeTimers() (R5).

interface Sleeper {
  readonly at: number;
  readonly resolve: () => void;
}

function flush(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

function virtualClock(): {
  now: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  advance: (ms: number) => Promise<void>;
  pending: () => number;
} {
  let t = 0;
  let sleepers: Sleeper[] = [];
  const now = (): number => t;
  const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const s: Sleeper = { at: t + ms, resolve };
      sleepers.push(s);
      signal?.addEventListener(
        'abort',
        () => {
          sleepers = sleepers.filter((x) => x !== s);
          reject(signal.reason);
        },
        { once: true },
      );
    });
  const advance = async (ms: number): Promise<void> => {
    const target = t + ms;
    await flush();
    for (;;) {
      const due = sleepers.filter((s) => s.at <= target).toSorted((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      sleepers = sleepers.filter((s) => s !== due);
      t = due.at;
      due.resolve();
      // oxlint-disable-next-line no-await-in-loop
      await flush();
    }
    t = target;
    await flush();
  };
  return { now, sleep, advance, pending: () => sleepers.length };
}

function noop(): void {}

function delaysOf(spy: { mock: { calls: readonly (readonly unknown[])[] } }): number[] {
  return spy.mock.calls.map((c) => Number(c[1] ?? 0));
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : '';
}

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function deferred(): Deferred {
  let resolve: () => void = noop;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// A gauge-tracked fn: counts in-flight calls and waits on a gate the test releases.
function gauge(): {
  cur: number;
  peak: number;
  starts: number[];
  gates: Deferred[];
  fn: (now: () => number) => () => Promise<string>;
} {
  const g = {
    cur: 0,
    peak: 0,
    starts: [] as number[],
    gates: [] as Deferred[],
    fn: (now: () => number) => async (): Promise<string> => {
      g.cur += 1;
      g.peak = Math.max(g.peak, g.cur);
      g.starts.push(now());
      const gate = deferred();
      g.gates.push(gate);
      try {
        await gate.promise;
        return 'ok';
      } finally {
        g.cur -= 1;
      }
    },
  };
  return g;
}

function retryable(retryAfterMs?: number): VetError {
  return new VetError('JUDGE_UNAVAILABLE', 'judge transport error (HTTP 429)', {
    details: retryAfterMs === undefined ? { retryable: true } : { retryable: true, retryAfterMs },
  });
}

// A connection-level failure (transport.ts's networkErrorHint branch): retryable, but with a
// `hint` and no `retryAfterMs` — unlike a 429/5xx, which never carries a hint.
function networkUnreachable(hint = 'ECONNREFUSED'): VetError {
  return new VetError('JUDGE_UNAVAILABLE', `judge is unreachable (${hint})`, {
    details: { retryable: true, hint },
  });
}

// fn that fails with the given errors in order, then resolves.
function failThen(errors: unknown[]): { fn: () => Promise<string>; calls: () => number } {
  let calls = 0;
  return {
    fn: async (): Promise<string> => {
      calls += 1;
      const e = errors[calls - 1];
      if (e !== undefined) throw e;
      return 'ok';
    },
    calls: () => calls,
  };
}

async function settle<T>(
  p: Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await p };
  } catch (error) {
    return { ok: false, error };
  }
}

function causeOf(e: unknown): { error: unknown; attempts: number } {
  if (!VetError.isInstance(e)) throw new Error('expected a VetError');
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return e.cause as { error: unknown; attempts: number };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createLimiter ceiling', () => {
  it('ceiling holds under 20 concurrent run()', async () => {
    const clock = virtualClock();
    const limiter = createLimiter({ now: clock.now, sleep: clock.sleep });
    const g = gauge();
    const runs = Array.from({ length: 20 }, () => limiter.run(g.fn(clock.now)));
    await flush();
    expect(g.cur).toBe(4);
    expect(limiter.stats()).toMatchObject({ inFlight: 4, ceiling: 4, queued: 16 });
    for (let released = 0; released < 20; released += 1) {
      g.gates[released]?.resolve();
      // oxlint-disable-next-line no-await-in-loop
      await flush();
      expect(g.cur).toBeLessThanOrEqual(4);
    }
    await expect(Promise.all(runs)).resolves.toHaveLength(20);
    expect(g.peak).toBe(4);
    expect(g.starts).toHaveLength(20);
  });
});

describe('createLimiter retry and AIMD', () => {
  it('retry-after honoured', async () => {
    const clock = virtualClock();
    const limiter = createLimiter({ now: clock.now, sleep: clock.sleep });
    const starts: number[] = [];
    const first = failThen([retryable(7000)]);
    const a = limiter.run(async () => {
      starts.push(clock.now());
      return first.fn();
    });
    await flush();
    const b = limiter.run(async () => {
      starts.push(clock.now());
      return 'b';
    });
    await clock.advance(6999);
    expect(starts).toEqual([0]);
    expect(first.calls()).toBe(1);
    await clock.advance(1);
    await expect(a).resolves.toBe('ok');
    await expect(b).resolves.toBe('b');
    expect(starts.slice(1).every((t) => t >= 7000)).toBe(true);
    expect(starts).toHaveLength(3);
  });

  it('retry-after honoured with no 60 s cap (90000 ms)', async () => {
    const clock = virtualClock();
    const limiter = createLimiter({ now: clock.now, sleep: clock.sleep });
    const f = failThen([retryable(90_000)]);
    const a = limiter.run(f.fn);
    await clock.advance(89_999);
    expect(f.calls()).toBe(1);
    expect(limiter.stats().pausedUntil).toBe(90_000);
    await clock.advance(1);
    await expect(a).resolves.toBe('ok');
    expect(f.calls()).toBe(2);
  });

  it('AIMD halves then recovers', async () => {
    const clock = virtualClock();
    const limiter = createLimiter({ now: clock.now, sleep: clock.sleep });
    expect(limiter.stats().ceiling).toBe(4);
    const one = limiter.run(failThen([retryable(10)]).fn);
    await clock.advance(10);
    await one;
    expect(limiter.stats().ceiling).toBe(2);
    const two = limiter.run(failThen([retryable(10)]).fn);
    await clock.advance(10);
    await two;
    expect(limiter.stats().ceiling).toBe(1);
    const three = limiter.run(failThen([retryable(10)]).fn);
    await clock.advance(10);
    await three;
    expect(limiter.stats().ceiling).toBe(1);
    // Each failure resets the success streak; the third call's retry is success 1 of 10.
    for (let i = 0; i < 9; i += 1) {
      // oxlint-disable-next-line no-await-in-loop
      await limiter.run(async () => 'ok');
    }
    expect(limiter.stats().ceiling).toBe(2);
    for (let i = 0; i < 50; i += 1) {
      // oxlint-disable-next-line no-await-in-loop
      await limiter.run(async () => 'ok');
    }
    expect(limiter.stats().ceiling).toBe(4);
  });

  it('a call that resolves after the ceiling was halved counts as a success', async () => {
    const clock = virtualClock();
    const limiter = createLimiter({ now: clock.now, sleep: clock.sleep });
    const g = gauge();
    const slow = limiter.run(g.fn(clock.now));
    const failing = limiter.run(failThen([retryable(10)]).fn);
    await flush();
    expect(limiter.stats().ceiling).toBe(2);
    g.gates[0]?.resolve();
    await slow;
    await clock.advance(10);
    await failing;
    // slow + failing's retry = 2 successes after the halving; 8 more grow the ceiling.
    for (let i = 0; i < 8; i += 1) {
      // oxlint-disable-next-line no-await-in-loop
      await limiter.run(async () => 'ok');
    }
    expect(limiter.stats().ceiling).toBe(3);
  });

  it('a retrying call releases its slot and re-queues against the halved ceiling', async () => {
    const clock = virtualClock();
    const limiter = createLimiter({ now: clock.now, sleep: clock.sleep });
    const g = gauge();
    const held = [0, 1, 2].map(() => limiter.run(g.fn(clock.now)));
    const failing = limiter.run(failThen([retryable(100)]).fn);
    const queued = Array.from({ length: 6 }, () => limiter.run(g.fn(clock.now)));
    await flush();
    expect(limiter.stats().ceiling).toBe(2);
    expect(limiter.stats().inFlight).toBe(3);
    for (const gate of g.gates.slice(0, 3)) gate.resolve();
    await Promise.all(held);
    g.peak = 0;
    await clock.advance(100);
    for (let i = 0; i < 10; i += 1) {
      expect(limiter.stats().inFlight).toBeLessThanOrEqual(2);
      for (const gate of g.gates) gate.resolve();
      // oxlint-disable-next-line no-await-in-loop
      await flush();
    }
    await expect(failing).resolves.toBe('ok');
    await Promise.all(queued);
    expect(g.peak).toBeLessThanOrEqual(2);
    expect(g.peak).toBeGreaterThan(0);
  });

  it('full-jitter backoff', async () => {
    const clock = virtualClock();
    const events: PacingEvent[] = [];
    const limiter = createLimiter({
      now: clock.now,
      sleep: clock.sleep,
      random: () => 0.5,
      emit: (e) => events.push(e),
    });
    const f = failThen([retryable(), retryable()]);
    const a = limiter.run(f.fn);
    await flush();
    // attempt 1 failed: 0.5 · min(40000, 1000·2^1) = 1000
    expect(limiter.stats().pausedUntil).toBe(1000);
    await clock.advance(1000);
    // attempt 2 failed at t=1000: 0.5 · min(40000, 1000·2^2) = 2000
    expect(limiter.stats().pausedUntil).toBe(3000);
    await clock.advance(1999);
    expect(f.calls()).toBe(2);
    await clock.advance(1);
    await expect(a).resolves.toBe('ok');
    const waits = events.flatMap((e) => (e.type === 'judge.throttled' ? [e.retryAfterMs] : []));
    expect(waits).toEqual([1000, 2000]);
  });

  it('full-jitter backoff is capped at maxBackoffMs', async () => {
    const clock = virtualClock();
    const limiter = createLimiter({
      now: clock.now,
      sleep: clock.sleep,
      random: () => 1,
      maxBackoffMs: 1500,
    });
    const a = limiter.run(failThen([retryable(), retryable()]).fn);
    await flush();
    expect(limiter.stats().pausedUntil).toBe(1500);
    await clock.advance(1500);
    expect(limiter.stats().pausedUntil).toBe(3000);
    await clock.advance(1500);
    await expect(a).resolves.toBe('ok');
  });

  it('maxRetries exceeded rejects with the last error and attempts in cause', async () => {
    const clock = virtualClock();
    const limiter = createLimiter({ now: clock.now, sleep: clock.sleep, maxRetries: 2 });
    const errors = [retryable(10), retryable(10), retryable(10), retryable(10)];
    const f = failThen(errors);
    const a = settle(limiter.run(f.fn));
    await clock.advance(100);
    const r = await a;
    expect(f.calls()).toBe(3);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(VetError.isInstance(r.error)).toBe(true);
    expect(r.error).toMatchObject({ code: 'JUDGE_UNAVAILABLE', details: { retryable: true } });
    expect(causeOf(r.error)).toEqual({ error: errors[2], attempts: 3 });
    expect(messageOf(r.error)).toBe('judge transport error (HTTP 429) (after 3 attempts)');
  });

  // mol-0nw.30: a connection-level failure (details.hint set — ECONNREFUSED, DNS, reset) is
  // not merely asking for patience like a 429/5xx, so it gets a short, fixed retry budget
  // instead of the default maxRetries — here exhausting after 3 calls, not 7 — but the error
  // it exhausts with must stay JUDGE_UNAVAILABLE with its hint intact (never JUDGE_TIMEOUT,
  // which stays reserved for a real deadline; bug 0nw.29's AC).
  it('a network-unreachable failure exhausts on a short fixed budget, keeping JUDGE_UNAVAILABLE and the hint', async () => {
    const clock = virtualClock();
    const limiter = createLimiter({ now: clock.now, sleep: clock.sleep });
    const errors = [
      networkUnreachable(),
      networkUnreachable(),
      networkUnreachable(),
      networkUnreachable(),
    ];
    const f = failThen(errors);
    const a = settle(limiter.run(f.fn));
    await clock.advance(10_000);
    const r = await a;
    expect(f.calls()).toBe(3);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(VetError.isInstance(r.error)).toBe(true);
    expect(r.error).toMatchObject({
      code: 'JUDGE_UNAVAILABLE',
      details: { retryable: true, hint: 'ECONNREFUSED' },
    });
    expect(causeOf(r.error)).toEqual({ error: errors[2], attempts: 3 });
  });

  it('budget exhausted', async () => {
    const clock = virtualClock();
    const limiter = createLimiter({ now: clock.now, sleep: clock.sleep });
    const last = retryable(400_000);
    const f = failThen([last]);
    const r = await settle(limiter.run(f.fn));
    expect(f.calls()).toBe(1);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatchObject({ code: 'JUDGE_UNAVAILABLE' });
    expect(causeOf(r.error)).toEqual({ error: last, attempts: 1 });
    const message = messageOf(r.error);
    expect(message).toContain('judge transport error (HTTP 429)');
    expect(message).toContain('retry budget exhausted (suggested wait 400000ms)');
    expect(message).toContain('(after 1 attempts)');
    expect(limiter.stats().pausedUntil).toBe(0);
  });

  it('budget is per run() call: a later run() still retries after an earlier one exhausted', async () => {
    const clock = virtualClock();
    const limiter = createLimiter({ now: clock.now, sleep: clock.sleep, totalBudgetMs: 10_000 });
    const early = failThen([retryable(6000), retryable(6000)]);
    const a = settle(limiter.run(early.fn));
    await clock.advance(6000);
    const ra = await a;
    expect(early.calls()).toBe(2);
    expect(ra.ok).toBe(false);
    const later = failThen([retryable(6000)]);
    const b = limiter.run(later.fn);
    await clock.advance(6000);
    await expect(b).resolves.toBe('ok');
    expect(later.calls()).toBe(2);
  });

  it('non-retryable passes through', async () => {
    const clock = virtualClock();
    const limiter = createLimiter({ now: clock.now, sleep: clock.sleep });

    const noCredit = new VetError('JUDGE_UNAVAILABLE', 'judge account has no credit', {
      details: { retryable: false, hint: 'no credit' },
    });
    const f402 = failThen([noCredit]);
    const r402 = await settle(limiter.run(f402.fn));
    expect(f402.calls()).toBe(1);
    expect(r402.ok).toBe(false);
    if (r402.ok) return;
    expect(r402.error).toMatchObject({
      code: 'JUDGE_UNAVAILABLE',
      details: { retryable: false, hint: 'no credit' },
      message: 'judge account has no credit (after 1 attempts)',
    });
    expect(causeOf(r402.error)).toEqual({ error: noCredit, attempts: 1 });

    const timeout = new VetError('JUDGE_TIMEOUT', 'judge request timed out or the network failed');
    const fTimeout = failThen([timeout]);
    const rTimeout = await settle(limiter.run(fTimeout.fn));
    expect(fTimeout.calls()).toBe(1);
    expect(rTimeout.ok).toBe(false);
    if (rTimeout.ok) return;
    expect(rTimeout.error).toMatchObject({ code: 'JUDGE_TIMEOUT' });
    expect(causeOf(rTimeout.error)).toEqual({ error: timeout, attempts: 1 });

    const plain = new TypeError('boom');
    const fPlain = failThen([plain]);
    const rPlain = await settle(limiter.run(fPlain.fn));
    expect(fPlain.calls()).toBe(1);
    expect(rPlain.ok).toBe(false);
    if (rPlain.ok) return;
    expect(rPlain.error).toBe(plain);
    expect(VetError.isInstance(rPlain.error)).toBe(false);

    expect(limiter.stats()).toMatchObject({ ceiling: 4, retries: 0, throttles: 0, pausedUntil: 0 });
  });
});

describe('createLimiter abort', () => {
  it('abort while queued rejects with the abort reason and never calls fn', async () => {
    const clock = virtualClock();
    const limiter = createLimiter({ now: clock.now, sleep: clock.sleep, maxInFlight: 1 });
    const g = gauge();
    const holder = limiter.run(g.fn(clock.now));
    const controller = new AbortController();
    let called = false;
    const waiting = settle(
      limiter.run(
        async () => {
          called = true;
          return 'x';
        },
        { signal: controller.signal },
      ),
    );
    await flush();
    const reason = new Error('stop');
    controller.abort(reason);
    const r = await waiting;
    expect(r).toEqual({ ok: false, error: reason });
    expect(called).toBe(false);
    expect(limiter.stats().queued).toBe(0);
    g.gates[0]?.resolve();
    await holder;
  });

  it('abort while waiting out a retry rejects with the abort reason, no retry', async () => {
    const clock = virtualClock();
    const limiter = createLimiter({ now: clock.now, sleep: clock.sleep });
    const controller = new AbortController();
    const f = failThen([retryable(5000)]);
    const waiting = settle(limiter.run(f.fn, { signal: controller.signal }));
    await clock.advance(100);
    const reason = new Error('stop');
    controller.abort(reason);
    const r = await waiting;
    expect(r).toEqual({ ok: false, error: reason });
    await clock.advance(10_000);
    expect(f.calls()).toBe(1);
    expect(clock.pending()).toBe(0);
  });

  it('an already-aborted signal rejects without calling fn', async () => {
    const limiter = createLimiter();
    const reason = new Error('gone');
    let called = false;
    const r = await settle(
      limiter.run(
        async () => {
          called = true;
          return 'x';
        },
        { signal: AbortSignal.abort(reason) },
      ),
    );
    expect(r).toEqual({ ok: false, error: reason });
    expect(called).toBe(false);
  });
});

describe('createLimiter events and timers', () => {
  it('emits typed events', async () => {
    const write = vi.spyOn(process.stdout, 'write');
    const clock = virtualClock();
    const events: PacingEvent[] = [];
    const limiter = createLimiter({
      now: clock.now,
      sleep: clock.sleep,
      emit: (e) => events.push(e),
    });
    const a = limiter.run(failThen([retryable(250), retryable(500)]).fn);
    await clock.advance(250);
    await clock.advance(500);
    await expect(a).resolves.toBe('ok');
    expect(events).toEqual([
      { type: 'judge.throttled', retryAfterMs: 250, ceiling: 2 },
      { type: 'judge.retry', attempt: 2 },
      { type: 'judge.throttled', retryAfterMs: 500, ceiling: 1 },
      { type: 'judge.retry', attempt: 3 },
    ]);
    expect(limiter.stats()).toMatchObject({ retries: 2, throttles: 2 });
    expect(write).not.toHaveBeenCalled();
    expect(clock.pending()).toBe(0);
  });

  it('no pending timers when idle', async () => {
    vi.useFakeTimers();
    const limiter = createLimiter();
    expect(vi.getTimerCount()).toBe(0);
    const f = failThen([retryable(50)]);
    const a = limiter.run(f.fn);
    const b = limiter.run(async () => 'b');
    await vi.advanceTimersByTimeAsync(0);
    expect(f.calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(50);
    await expect(a).resolves.toBe('ok');
    await expect(b).resolves.toBe('b');
    expect(f.calls()).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  // mol-0nw.30 regression: defaultSleep's retry-wait `setTimeout` must stay ref'd. An unref'd
  // one is invisible to Node's "any work left?" check; if it is the only pending handle (a real
  // CLI process retrying a refused connection, nothing else running), Node exits(0) as soon as
  // it decides there is nothing to wait for — before the timer ever fires — abandoning the
  // retry with no output. Real (non-fake) timers only: a fake timer is never actually armed
  // against the event loop, so it can't demonstrate ref/unref either way.
  it("defaultSleep's retry-wait timer stays ref'd, not unref'd", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const limiter = createLimiter({ maxRetries: 1 });
    await limiter.run(failThen([retryable(5)]).fn);
    const returned: unknown = setTimeoutSpy.mock.results.at(-1)?.value;
    if (
      typeof returned !== 'object' ||
      returned === null ||
      !('hasRef' in returned) ||
      typeof returned.hasRef !== 'function'
    ) {
      throw new Error('expected setTimeout to return a Timeout with hasRef()');
    }
    expect(returned.hasRef()).toBe(true);
    setTimeoutSpy.mockRestore();
  });

  // mol-0nw.31: Bun prints TimeoutNegativeWarning when a computed delay goes below zero.
  it('never passes a negative delay to setTimeout for a Retry-After in the past', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const events: PacingEvent[] = [];
    const limiter = createLimiter({ maxRetries: 1, emit: (e) => events.push(e) });
    await limiter.run(failThen([retryable(-5000)]).fn);
    expect(delaysOf(setTimeoutSpy).every((d) => d >= 0)).toBe(true);
    for (const e of events) {
      if (e.type === 'judge.throttled') expect(e.retryAfterMs).toBeGreaterThanOrEqual(0);
    }
    setTimeoutSpy.mockRestore();
  });

  it('never passes a negative delay to setTimeout when the clock advances past the pause', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    let t = 0;
    const limiter = createLimiter({
      maxRetries: 1,
      now: () => {
        t += 7;
        return t;
      },
    });
    const outcome = await Promise.race([
      limiter.run(failThen([retryable(10)]).fn),
      new Promise<string>((r) => {
        setTimeout(() => r('stalled'), 300);
      }),
    ]);
    expect(outcome).toBe('ok');
    expect(delaysOf(setTimeoutSpy).every((d) => d >= 0)).toBe(true);
    setTimeoutSpy.mockRestore();
  });

  it('clamps the sleep to zero when the deadline has already expired', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    let t = 0;
    const limiter = createLimiter({
      maxRetries: 3,
      totalBudgetMs: 0,
      now: () => {
        t += 7;
        return t;
      },
    });
    await limiter.run(failThen([retryable(-1)]).fn).catch(() => {});
    expect(delaysOf(setTimeoutSpy).every((d) => d >= 0)).toBe(true);
    setTimeoutSpy.mockRestore();
  });
});
