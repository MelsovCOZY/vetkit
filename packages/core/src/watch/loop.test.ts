// docs/contracts/j7.md "Sampling rule" / "Inclusion log"; bead classified-evals-mol-dh8.2.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedTrace, SinkAck, SinkV1, SourceV1, Verdict } from '@vetkit/spec';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createOutbox, type Outbox } from '../outbox/outbox.ts';
import { runWatch, type JudgeCaseFn, type RunWatchOptions } from './loop.ts';
import { createSampler, hashToUnit } from './sampler.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vet-loop-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function trace(traceId: string, overrides: Partial<NormalizedTrace['completeness']> = {}): NormalizedTrace {
  return {
    traceId,
    spans: [],
    dialect: 'openai',
    messages: [
      { role: 'user', parts: [{ type: 'text', content: 'hi' }] },
      { role: 'assistant', parts: [{ type: 'text', content: 'hello' }] },
    ],
    completeness: { contentCaptured: true, truncated: false, missingParents: false, ...overrides },
  };
}

/** Finds `below` ids with hashToUnit < rate and `above` ids with hashToUnit >= rate. */
function partitionIds(rate: number, below: number, above: number): string[] {
  const belowIds: string[] = [];
  const aboveIds: string[] = [];
  for (let i = 0; belowIds.length < below || aboveIds.length < above; i += 1) {
    const id = `trace-${i}`;
    const u = hashToUnit(id);
    if (u < rate && belowIds.length < below) belowIds.push(id);
    else if (u >= rate && aboveIds.length < above) aboveIds.push(id);
  }
  return [...belowIds, ...aboveIds];
}

function finiteSource(traces: readonly NormalizedTrace[]): SourceV1 {
  return {
    specVersion: 'v1',
    id: 'fake-source',
    capabilities: { streaming: true, content: 'captured' },
    async *doRead() {
      for (const t of traces) yield t;
    },
  };
}

/** Simulates the J5 receiver: yields `traces`, then blocks until `signal` aborts. */
function blockingSource(traces: readonly NormalizedTrace[]): SourceV1 {
  return {
    specVersion: 'v1',
    id: 'fake-blocking-source',
    capabilities: { streaming: true, content: 'captured' },
    async *doRead({ signal }) {
      for (const t of traces) yield t;
      await new Promise<void>((resolve) => {
        if (signal?.aborted === true) {
          resolve();
          return;
        }
        signal?.addEventListener('abort', () => resolve(), { once: true });
      });
    },
  };
}

function throwingSource(traces: readonly NormalizedTrace[], err: Error): SourceV1 {
  return {
    specVersion: 'v1',
    id: 'fake-throwing-source',
    capabilities: { streaming: true, content: 'captured' },
    async *doRead() {
      for (const t of traces) yield t;
      throw err;
    },
  };
}

function fakeSink(onWrite?: (batch: Verdict[]) => void): SinkV1 {
  return {
    specVersion: 'v1',
    id: 'fake-sink',
    capabilities: { batch: 100, idempotent: true },
    async doWrite(batch): Promise<SinkAck> {
      onWrite?.(batch);
      return { accepted: batch.map((v) => v.id ?? ''), rejected: [] };
    },
  };
}

function watchOptions(overrides: Partial<RunWatchOptions> = {}): RunWatchOptions {
  return {
    sampleRate: 0.5,
    maxInFlight: 4,
    promoteOn: 'never',
    inclusionPath: join(dir, 'inclusion.jsonl'),
    promotedDir: join(dir, 'evals'),
    ...overrides,
  };
}

function okVerdict(caseId: string): Verdict {
  return {
    caseId,
    criterionId: 'k1',
    status: 'ok',
    pass: true,
    model: { requested: 'm', resolved: 'm', transport: 't', pinned: false },
    cacheHit: false,
  };
}

async function waitUntil(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

async function inclusionLineCount(path: string): Promise<number> {
  const text = await readFile(path, 'utf8');
  return text.split('\n').filter((l) => l !== '').length;
}

describe('runWatch', () => {
  test('counts: samples exactly the traces with hash < rate, judges only those, and enqueues every verdict before any sink write', async () => {
    const ids = partitionIds(0.5, 10, 10);
    const traces = ids.map((id) => trace(id));
    const outbox = createOutbox({ dir: join(dir, 'outbox') });
    const log: string[] = [];
    const wrappedOutbox: Outbox = {
      ...outbox,
      enqueue: async (verdicts) => {
        log.push('enqueue');
        return outbox.enqueue(verdicts);
      },
    };
    const sink = fakeSink(() => log.push('sink-write'));
    const judge: JudgeCaseFn = async ({ case: c }) => [okVerdict(c.id)];

    const summary = await runWatch({
      source: finiteSource(traces),
      sampler: createSampler({ sampleRate: 0.5, inclusionPath: join(dir, 'inclusion.jsonl') }),
      judge,
      outbox: wrappedOutbox,
      sinks: [sink],
      options: watchOptions(),
      signal: new AbortController().signal,
    });

    expect(summary.seen).toBe(20);
    expect(summary.sampled).toBe(10);
    expect(summary.judged).toBe(10);
    expect(summary.promoted).toBe(0);
    expect(summary.produced).toBe(10);
    expect(summary.acknowledged).toBe(10);

    const lastEnqueue = log.lastIndexOf('enqueue');
    const firstSinkWrite = log.indexOf('sink-write');
    expect(firstSinkWrite).toBeGreaterThan(lastEnqueue);
  });

  test('concurrency cap: at most maxInFlight judge calls run at once, measured with a gate promise', async () => {
    const ids = partitionIds(1, 5, 0);
    const traces = ids.map((id) => trace(id));
    const outbox = createOutbox({ dir: join(dir, 'outbox') });
    const maxInFlight = 2;
    let active = 0;
    let maxActive = 0;
    let started = 0;
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const judge: JudgeCaseFn = async ({ case: c }) => {
      active += 1;
      started += 1;
      maxActive = Math.max(maxActive, active);
      await gate;
      active -= 1;
      return [okVerdict(c.id)];
    };

    const runPromise = runWatch({
      source: finiteSource(traces),
      sampler: createSampler({ sampleRate: 1, inclusionPath: join(dir, 'inclusion.jsonl') }),
      judge,
      outbox,
      sinks: [fakeSink()],
      options: watchOptions({ sampleRate: 1, maxInFlight }),
      signal: new AbortController().signal,
    });

    await waitUntil(() => started === maxInFlight);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(active).toBe(maxInFlight);
    releaseGate();

    const summary = await runPromise;
    expect(summary.judged).toBe(5);
    expect(maxActive).toBe(maxInFlight);
  });

  test('abort drains the outbox once and resolves with the coverage summary', async () => {
    const ids = partitionIds(0.5, 10, 10);
    const traces = ids.map((id) => trace(id));
    const outbox = createOutbox({ dir: join(dir, 'outbox') });
    let drainCalls = 0;
    const wrappedOutbox: Outbox = {
      ...outbox,
      drain: async (sinks) => {
        drainCalls += 1;
        return outbox.drain(sinks);
      },
    };
    const judge: JudgeCaseFn = async ({ case: c }) => [okVerdict(c.id)];
    let completed = 0;
    let resolveTenDone: () => void = () => {};
    const tenDone = new Promise<void>((resolve) => {
      resolveTenDone = resolve;
    });
    const onVerdict = (): void => {
      completed += 1;
      if (completed === 10) resolveTenDone();
    };

    const controller = new AbortController();
    const runPromise = runWatch({
      source: blockingSource(traces),
      sampler: createSampler({ sampleRate: 0.5, inclusionPath: join(dir, 'inclusion.jsonl') }),
      judge,
      outbox: wrappedOutbox,
      sinks: [fakeSink()],
      options: watchOptions(),
      signal: controller.signal,
      onVerdict,
    });

    await tenDone;
    controller.abort();
    const summary = await runPromise;

    expect(summary).toEqual({
      seen: 20,
      sampled: 10,
      judged: 10,
      promoted: 0,
      produced: 10,
      acknowledged: 10,
    });
    expect(drainCalls).toBe(1);
  });

  test("judge throw -> a Verdict with status 'infra_failure' is still enqueued", async () => {
    const ids = partitionIds(1, 1, 0);
    const traces = ids.map((id) => trace(id));
    const outbox = createOutbox({ dir: join(dir, 'outbox') });
    const judge: JudgeCaseFn = () => {
      throw new Error('judge exploded');
    };

    const summary = await runWatch({
      source: finiteSource(traces),
      sampler: createSampler({ sampleRate: 1, inclusionPath: join(dir, 'inclusion.jsonl') }),
      judge,
      outbox,
      sinks: [fakeSink()],
      options: watchOptions({ sampleRate: 1 }),
      signal: new AbortController().signal,
    });

    expect(summary.judged).toBe(1);
    const pendingText = await readFile(join(dir, 'outbox', 'pending.jsonl'), 'utf8');
    const pending = pendingText
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l) as { verdict: Verdict });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.verdict.status).toBe('infra_failure');
    expect(pending[0]?.verdict.cause).toBe('judge exploded');
  });

  test('backpressure: maxInFlight=1 and 50 instantly-yielded traces write all 50 inclusion records and skip none', async () => {
    const ids = partitionIds(1, 50, 0);
    const traces = ids.map((id) => trace(id));
    const outbox = createOutbox({ dir: join(dir, 'outbox') });
    const judge: JudgeCaseFn = async ({ case: c }) => [okVerdict(c.id)];
    const inclusionPath = join(dir, 'inclusion.jsonl');

    const summary = await runWatch({
      source: finiteSource(traces),
      sampler: createSampler({ sampleRate: 1, inclusionPath }),
      judge,
      outbox,
      sinks: [fakeSink()],
      options: watchOptions({ sampleRate: 1, maxInFlight: 1 }),
      signal: new AbortController().signal,
    });

    expect(summary.seen).toBe(50);
    expect(summary.sampled).toBe(50);
    expect(summary.judged).toBe(50);
    expect(await inclusionLineCount(inclusionPath)).toBe(50);
  });

  test('source throws: the loop drains once, then rethrows', async () => {
    const ids = partitionIds(1, 2, 0);
    const traces = ids.map((id) => trace(id));
    const outbox = createOutbox({ dir: join(dir, 'outbox') });
    let drainCalls = 0;
    const wrappedOutbox: Outbox = {
      ...outbox,
      drain: async (sinks) => {
        drainCalls += 1;
        return outbox.drain(sinks);
      },
    };
    const boom = new Error('receiver died');
    const judge: JudgeCaseFn = async ({ case: c }) => [okVerdict(c.id)];

    await expect(
      runWatch({
        source: throwingSource(traces, boom),
        sampler: createSampler({ sampleRate: 1, inclusionPath: join(dir, 'inclusion.jsonl') }),
        judge,
        outbox: wrappedOutbox,
        sinks: [fakeSink()],
        options: watchOptions({ sampleRate: 1 }),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('receiver died');

    expect(drainCalls).toBe(1);
  });

  test('abort mid-judge: the in-flight call is aborted and its verdict is not enqueued', async () => {
    const t = trace('trace-mid');
    const outbox = createOutbox({ dir: join(dir, 'outbox') });
    let judgeStarted = false;
    const judge: JudgeCaseFn = ({ signal }) =>
      new Promise((_resolve, reject) => {
        judgeStarted = true;
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });

    const controller = new AbortController();
    const runPromise = runWatch({
      source: finiteSource([t]),
      sampler: createSampler({ sampleRate: 1, inclusionPath: join(dir, 'inclusion.jsonl') }),
      judge,
      outbox,
      sinks: [fakeSink()],
      options: watchOptions({ sampleRate: 1 }),
      signal: controller.signal,
    });

    await waitUntil(() => judgeStarted);
    controller.abort();
    const summary = await runPromise;

    expect(summary.judged).toBe(0);
    const pendingText = await readFile(join(dir, 'outbox', 'pending.jsonl'), 'utf8').catch(
      () => '',
    );
    expect(pendingText.split('\n').filter((l) => l !== '')).toHaveLength(0);
  });
});
