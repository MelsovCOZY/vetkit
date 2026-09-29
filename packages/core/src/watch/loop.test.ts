// docs/contracts/j7.md "Sampling rule" / "Inclusion log"; bead classified-evals-mol-dh8.2.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  safeParseJson,
  type Case,
  type Criterion,
  type NormalizedTrace,
  type SinkAck,
  type SinkV1,
  type SourceV1,
  type Verdict,
} from '@vetkit/spec';
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

function trace(
  traceId: string,
  overrides: Partial<NormalizedTrace['completeness']> = {},
): NormalizedTrace {
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

function readTraceId(provenance: unknown): string | undefined {
  if (typeof provenance !== 'object' || provenance === null) return undefined;
  const traceId = (provenance as { traceId?: unknown }).traceId;
  return typeof traceId === 'string' ? traceId : undefined;
}

/** Rejects any verdict with no `provenance.traceId`, reason 'no correlation id' — same rule
 * real otel/langfuse sinks apply (docs/sinks.md "Correlation"; bug classified-evals-mol-dh8.6). */
function correlationRequiringSink(): SinkV1 {
  return {
    specVersion: 'v1',
    id: 'fake-correlating-sink',
    capabilities: { batch: 100, idempotent: true },
    async doWrite(batch): Promise<SinkAck> {
      const accepted: string[] = [];
      const rejected: SinkAck['rejected'] = [];
      for (const v of batch) {
        const id = v.id ?? '';
        if (readTraceId(v.provenance) !== undefined) accepted.push(id);
        else rejected.push({ id, reason: 'no correlation id', retryable: false });
      }
      return { accepted, rejected };
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

function okVerdict(caseId: string, criterionId = 'k1'): Verdict {
  return {
    caseId,
    criterionId,
    status: 'ok',
    pass: true,
    model: { requested: 'm', resolved: 'm', transport: 't', pinned: false },
    cacheHit: false,
  };
}

function criterion(id: string, overrides: { contentDependent?: boolean } = {}): Criterion {
  return {
    id,
    type: 'boolean',
    instructions: 'x',
    escape: 'n/a',
    polarity: 'pass_when_true',
    channel: 'quality',
    contentDependent: true,
    provenance: { traceIds: [] },
    wordingHash: 'h',
    ...overrides,
  };
}

const defaultCriteria: Criterion[] = [criterion('k1')];

const alwaysOkJudge: JudgeCaseFn = async ({ case: c, criteria }) =>
  criteria.map((crit) => okVerdict(c.id, crit.id));

const throwingJudge: JudgeCaseFn = () => {
  throw new Error('judge exploded');
};

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

    const summary = await runWatch({
      source: finiteSource(traces),
      sampler: createSampler({ sampleRate: 0.5, inclusionPath: join(dir, 'inclusion.jsonl') }),
      judge: alwaysOkJudge,
      criteria: defaultCriteria,
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
    expect(summary.excluded).toEqual({
      content_not_captured: 0,
      truncated: 0,
      incomplete_trace: 0,
    });

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
    let releaseGate: (() => void) | undefined;
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
      criteria: defaultCriteria,
      outbox,
      sinks: [fakeSink()],
      options: watchOptions({ sampleRate: 1, maxInFlight }),
      signal: new AbortController().signal,
    });

    await waitUntil(() => started === maxInFlight);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(active).toBe(maxInFlight);
    releaseGate?.();

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
    let completed = 0;
    let resolveTenDone: (() => void) | undefined;
    const tenDone = new Promise<void>((resolve) => {
      resolveTenDone = resolve;
    });
    const onVerdict = (): void => {
      completed += 1;
      if (completed === 10) resolveTenDone?.();
    };

    const controller = new AbortController();
    const runPromise = runWatch({
      source: blockingSource(traces),
      sampler: createSampler({ sampleRate: 0.5, inclusionPath: join(dir, 'inclusion.jsonl') }),
      judge: alwaysOkJudge,
      criteria: defaultCriteria,
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
      excluded: { content_not_captured: 0, truncated: 0, incomplete_trace: 0 },
    });
    expect(drainCalls).toBe(1);
  });

  test("judge throw -> a Verdict with status 'infra_failure' is still enqueued", async () => {
    const ids = partitionIds(1, 1, 0);
    const traces = ids.map((id) => trace(id));
    const outbox = createOutbox({ dir: join(dir, 'outbox') });

    const summary = await runWatch({
      source: finiteSource(traces),
      sampler: createSampler({ sampleRate: 1, inclusionPath: join(dir, 'inclusion.jsonl') }),
      judge: throwingJudge,
      criteria: defaultCriteria,
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
      .map((l) => {
        const parsed = safeParseJson<{ verdict: Verdict }>(l, {});
        if (!parsed.ok) throw parsed.error;
        return parsed.value;
      });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.verdict.status).toBe('infra_failure');
    expect(pending[0]?.verdict.cause).toBe('judge exploded');
  });

  test('backpressure: maxInFlight=1 and 50 instantly-yielded traces write all 50 inclusion records and skip none', async () => {
    const ids = partitionIds(1, 50, 0);
    const traces = ids.map((id) => trace(id));
    const outbox = createOutbox({ dir: join(dir, 'outbox') });
    const inclusionPath = join(dir, 'inclusion.jsonl');

    const summary = await runWatch({
      source: finiteSource(traces),
      sampler: createSampler({ sampleRate: 1, inclusionPath }),
      judge: alwaysOkJudge,
      criteria: defaultCriteria,
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

    await expect(
      runWatch({
        source: throwingSource(traces, boom),
        sampler: createSampler({ sampleRate: 1, inclusionPath: join(dir, 'inclusion.jsonl') }),
        judge: alwaysOkJudge,
        criteria: defaultCriteria,
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
      criteria: defaultCriteria,
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

  test('truncated: a case with one content-independent and one content-dependent criterion is judged on exactly the content-independent one', async () => {
    const t = trace('trace-truncated', { truncated: true });
    const criteria = [
      criterion('k-independent', { contentDependent: false }),
      criterion('k-dependent', { contentDependent: true }),
    ];
    const outbox = createOutbox({ dir: join(dir, 'outbox') });
    let receivedCriteria: readonly Criterion[] = [];
    const judge: JudgeCaseFn = async ({ case: c, criteria: given }) => {
      receivedCriteria = given;
      return given.map((crit) => okVerdict(c.id, crit.id));
    };

    const summary = await runWatch({
      source: finiteSource([t]),
      sampler: createSampler({ sampleRate: 1, inclusionPath: join(dir, 'inclusion.jsonl') }),
      judge,
      criteria,
      outbox,
      sinks: [fakeSink()],
      options: watchOptions({ sampleRate: 1 }),
      signal: new AbortController().signal,
    });

    expect(receivedCriteria.map((c) => c.id)).toEqual(['k-independent']);
    expect(summary.judged).toBe(1);
    expect(summary.excluded).toEqual({
      content_not_captured: 0,
      truncated: 1,
      incomplete_trace: 0,
    });
  });

  test('onVerdict gets id and case: verdict.id is exactly what outbox.enqueue returned, evalCase is the judged Case (bug dh8.5)', async () => {
    const t = trace('trace-onverdict');
    const baseOutbox = createOutbox({ dir: join(dir, 'outbox') });
    const wrappedOutbox: Outbox = {
      ...baseOutbox,
      enqueue: async (verdicts) => {
        await baseOutbox.enqueue(verdicts);
        // Known ids, deliberately different from anything the verdicts arrived with.
        return verdicts.map((_, i) => `known-id-${String(i)}`);
      },
    };
    const received: Array<{ id: string | undefined; evalCase: Case }> = [];
    const onVerdict = (verdict: Verdict, evalCase: Case): boolean => {
      received.push({ id: verdict.id, evalCase });
      return false;
    };

    await runWatch({
      source: finiteSource([t]),
      sampler: createSampler({ sampleRate: 1, inclusionPath: join(dir, 'inclusion.jsonl') }),
      judge: alwaysOkJudge,
      criteria: defaultCriteria,
      outbox: wrappedOutbox,
      sinks: [fakeSink()],
      options: watchOptions({ sampleRate: 1 }),
      signal: new AbortController().signal,
      onVerdict,
    });

    expect(received).toHaveLength(1);
    expect(received[0]?.id).toBe('known-id-0');
    expect(received[0]?.evalCase.traceId).toBe('trace-onverdict');
  });

  // bug classified-evals-mol-dh8.6: OTLP-derived cases carried no provenance.traceId/spanId, so
  // a correlation-requiring sink dead-lettered every verdict ('no correlation id'). The judge
  // here plays the role a real judge/adapter does: it copies the case's own provenance.traceId
  // onto the Verdict it returns, so the sink can decide whether to accept it.
  test('a fake sink requiring provenance.traceId acknowledges every verdict when the case carries traceId (bug dh8.6)', async () => {
    const t = trace('trace-otel');
    const outbox = createOutbox({ dir: join(dir, 'outbox') });
    const judge: JudgeCaseFn = async ({ case: c, criteria }) =>
      criteria.map((crit) => ({
        ...okVerdict(c.id, crit.id),
        provenance: { traceId: readTraceId(c.provenance) },
      }));

    const summary = await runWatch({
      source: finiteSource([t]),
      sampler: createSampler({ sampleRate: 1, inclusionPath: join(dir, 'inclusion.jsonl') }),
      judge,
      criteria: defaultCriteria,
      outbox,
      sinks: [correlationRequiringSink()],
      options: watchOptions({ sampleRate: 1 }),
      signal: new AbortController().signal,
    });

    expect(summary.produced).toBeGreaterThan(0);
    expect(summary.acknowledged).toBe(summary.produced);
  });
});
