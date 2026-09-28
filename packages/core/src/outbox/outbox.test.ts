import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CEV_ERROR_CODES,
  safeParseJson,
  VetError,
  type SinkAck,
  type SinkV1,
  type Verdict,
} from '@vetkit/spec';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { backoffDelay } from './backoff.ts';
import { createOutbox, type OutboxOptions } from './outbox.ts';

let dir: string;
let sleeps: number[];

beforeEach(async () => {
  dir = join(await mkdtemp(join(tmpdir(), 'vet-outbox-')), 'outbox');
  sleeps = [];
});

afterEach(async () => {
  await rm(join(dir, '..'), { recursive: true, force: true });
});

function opts(extra: Partial<OutboxOptions> = {}): OutboxOptions {
  return {
    dir,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    random: () => 0.5,
    ...extra,
  };
}

function verdict(n: number, id?: string): Verdict {
  return {
    ...(id === undefined ? {} : { id }),
    caseId: `c${n}`,
    criterionId: 'k1',
    status: 'ok',
    pass: true,
    model: { requested: 'm', resolved: 'm', transport: 't', pinned: false },
    cacheHit: false,
  };
}

function verdicts(count: number): Verdict[] {
  return Array.from({ length: count }, (_, i) => verdict(i, `v${i}`));
}

type Handler = (batch: Verdict[], call: number) => SinkAck | Promise<SinkAck>;

interface FakeSink extends SinkV1 {
  calls: Verdict[][];
}

function fakeSink(
  handler: Handler,
  { id = 'fake', batch = 100, idempotent = true } = {},
): FakeSink {
  const calls: Verdict[][] = [];
  return {
    specVersion: 'v1',
    id,
    capabilities: { batch, idempotent },
    calls,
    async doWrite(b) {
      calls.push(b);
      return handler(b, calls.length);
    },
  };
}

function ids(batch: Verdict[]): string[] {
  return batch.map((v) => v.id ?? '');
}

const acceptAll: Handler = (b) => ({ accepted: ids(b), rejected: [] });

async function lines(name: string): Promise<unknown[]> {
  let text: string;
  try {
    text = await readFile(join(dir, name), 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => {
      const parsed = safeParseJson<unknown>(l, {});
      if (!parsed.ok) throw parsed.error;
      return parsed.value;
    });
}

describe('backoffDelay', () => {
  test('is 100 ms x 2^n scaled by jitter in [0.5, 1.5)', () => {
    expect(backoffDelay(0, () => 0.5)).toBe(100);
    expect(backoffDelay(1, () => 0.5)).toBe(200);
    expect(backoffDelay(1, () => 0)).toBe(100);
  });
});

describe('createOutbox', () => {
  test('happy path', async () => {
    const outbox = createOutbox(opts());
    let pendingAtCall = 0;
    const sink = fakeSink(async (b) => {
      pendingAtCall = (await lines('pending.jsonl')).length;
      return acceptAll(b, 1);
    });
    const vs = verdicts(4);
    await outbox.enqueue(vs);
    const [result] = await outbox.drain([sink]);
    expect(pendingAtCall).toBe(4);
    expect(result).toMatchObject({ sink: 'fake', acknowledged: 4, dead: 0, pending: 0 });
    const acked = await lines('acked.jsonl');
    expect(acked).toHaveLength(4);
    expect(acked[0]).toMatchObject({ id: 'v0', sink: 'fake' });
  });

  test('enqueue assigns an id when absent and returns ids in input order', async () => {
    const outbox = createOutbox(opts());
    const out = await outbox.enqueue([verdict(0, 'given'), verdict(1)]);
    expect(out[0]).toBe('given');
    expect(out[1]).toMatch(/^[0-9a-f-]{36}$/);
    const pending = await lines('pending.jsonl');
    expect(pending[1]).toMatchObject({ id: out[1], verdict: { id: out[1] } });
  });

  test('enqueue does not mutate input', async () => {
    const outbox = createOutbox(opts());
    const v = verdict(0);
    await outbox.enqueue([v]);
    expect(v.id).toBeUndefined();
  });

  test('retryable then success', async () => {
    const outbox = createOutbox(opts());
    const sink = fakeSink((b, call) =>
      call === 1
        ? {
            accepted: ids(b).slice(1),
            rejected: [{ id: ids(b)[0] ?? '', reason: '429', retryable: true }],
          }
        : acceptAll(b, call),
    );
    await outbox.enqueue(verdicts(3));
    const [result] = await outbox.drain([sink]);
    expect(sink.calls).toHaveLength(2);
    expect(ids(sink.calls[1] ?? [])).toEqual(['v0']);
    expect(sleeps).toEqual([100]);
    expect(result).toMatchObject({ acknowledged: 3, retried: 1, dead: 0, pending: 0 });
  });

  test('non-retryable → dead', async () => {
    const outbox = createOutbox(opts());
    const sink = fakeSink((b) => ({
      accepted: ids(b).slice(1),
      rejected: [{ id: 'v0', reason: 'no correlation id', retryable: false }],
    }));
    await outbox.enqueue(verdicts(2));
    const [result] = await outbox.drain([sink]);
    expect(sink.calls).toHaveLength(1);
    expect(result).toMatchObject({ acknowledged: 1, dead: 1 });
    expect(await lines('dead.jsonl')).toEqual([
      expect.objectContaining({ id: 'v0', sink: 'fake', reason: 'no correlation id' }),
    ]);
  });

  test('batch split by capabilities.batch', async () => {
    const outbox = createOutbox(opts());
    const sink = fakeSink(acceptAll, { batch: 2 });
    await outbox.enqueue(verdicts(5));
    const [result] = await outbox.drain([sink]);
    expect(sink.calls.map((c) => c.length)).toEqual([2, 2, 1]);
    expect(result).toMatchObject({ sent: 5, acknowledged: 5 });
  });

  test('reconcile-retry', async () => {
    const outbox = createOutbox(opts());
    const sink = fakeSink((b, call) =>
      call === 1
        ? {
            accepted: ids(b).slice(3),
            rejected: ids(b)
              .slice(0, 3)
              .map((id) => ({ id, reason: '503', retryable: true })),
          }
        : acceptAll(b, call),
    );
    await outbox.enqueue(verdicts(10));
    await outbox.drain([sink]);
    expect(await outbox.reconcile()).toEqual({ produced: 10, acknowledged: 10, dead: 0 });
  });

  test('reconcile-dead', async () => {
    const outbox = createOutbox(opts());
    const sink = fakeSink((b) => ({
      accepted: ids(b).slice(3),
      rejected: ids(b)
        .slice(0, 3)
        .map((id) => ({ id, reason: 'bad', retryable: false })),
    }));
    await outbox.enqueue(verdicts(10));
    await outbox.drain([sink]);
    expect(await outbox.reconcile()).toEqual({ produced: 10, acknowledged: 7, dead: 3 });
  });

  test('reconcile two sinks, one unreachable', async () => {
    const outbox = createOutbox(opts());
    const a = fakeSink(acceptAll, { id: 'a' });
    const b = fakeSink(
      () => {
        throw new VetError(CEV_ERROR_CODES.SINK_UNREACHABLE, 'collector down');
      },
      { id: 'b' },
    );
    await outbox.enqueue(verdicts(4));
    const results = await outbox.drain([a, b]);
    expect(results.map((r) => r.sink)).toEqual(['a', 'b']);
    expect(await outbox.reconcile({ sinks: ['a', 'b'] })).toEqual({
      produced: 4,
      acknowledged: 0,
      dead: 0,
    });
  });

  test('retryable exhausted stays pending; a second drain acks it', async () => {
    const outbox = createOutbox(opts());
    let down = true;
    const sink = fakeSink((b) => {
      if (down) throw new VetError(CEV_ERROR_CODES.SINK_UNREACHABLE, 'collector down');
      return acceptAll(b, 0);
    });
    await outbox.enqueue(verdicts(2));
    const [first] = await outbox.drain([sink]);
    expect(sink.calls).toHaveLength(3);
    expect(first).toMatchObject({ acknowledged: 0, dead: 0, pending: 2 });
    expect(await lines('dead.jsonl')).toEqual([]);
    down = false;
    const [second] = await outbox.drain([sink]);
    expect(second).toMatchObject({ acknowledged: 2, pending: 0 });
    expect(await outbox.reconcile()).toEqual({ produced: 2, acknowledged: 2, dead: 0 });
  });

  test('a thrown non-retryable SINK_ error dead-letters the batch', async () => {
    const outbox = createOutbox(opts());
    const sink = fakeSink(() => {
      throw new VetError(CEV_ERROR_CODES.SINK_AUTH, 'forbidden', {
        details: { retryable: false },
      });
    });
    await outbox.enqueue(verdicts(2));
    const [result] = await outbox.drain([sink]);
    expect(result).toMatchObject({ dead: 2, pending: 0 });
  });

  test('a timeout is retried', async () => {
    const outbox = createOutbox(opts());
    const sink = fakeSink((b, call) => {
      if (call === 1) throw new DOMException('timed out', 'TimeoutError');
      return acceptAll(b, call);
    });
    await outbox.enqueue(verdicts(1));
    const [result] = await outbox.drain([sink]);
    expect(result).toMatchObject({ acknowledged: 1, retried: 1 });
  });

  test('payload too large halves the batch and retries', async () => {
    const outbox = createOutbox(opts());
    const sink = fakeSink((b) => {
      if (b.length > 1) throw new VetError(CEV_ERROR_CODES.SINK_PAYLOAD_TOO_LARGE, '413');
      return acceptAll(b, 0);
    });
    await outbox.enqueue(verdicts(4));
    const [result] = await outbox.drain([sink]);
    expect(sink.calls.map((c) => c.length)).toEqual([4, 2, 1, 1, 2, 1, 1]);
    expect(result).toMatchObject({ acknowledged: 4, dead: 0 });
  });

  test('a single item still too large goes to dead', async () => {
    const outbox = createOutbox(opts());
    const sink = fakeSink(() => {
      throw new VetError(CEV_ERROR_CODES.SINK_PAYLOAD_TOO_LARGE, '413');
    });
    await outbox.enqueue(verdicts(1));
    const [result] = await outbox.drain([sink]);
    expect(sink.calls).toHaveLength(1);
    expect(result).toMatchObject({ dead: 1, pending: 0 });
  });

  test('resume', async () => {
    await createOutbox(opts()).enqueue(verdicts(3));
    const sink = fakeSink(acceptAll);
    const [result] = await createOutbox(opts()).drain([sink]);
    expect(result).toMatchObject({ acknowledged: 3 });
    const [again] = await createOutbox(opts()).drain([sink]);
    expect(again).toMatchObject({ sent: 0, acknowledged: 0 });
  });

  test('corrupt', async () => {
    const outbox = createOutbox(opts());
    await outbox.enqueue(verdicts(1));
    await appendFile(join(dir, 'pending.jsonl'), '{not json\n');
    const err: unknown = await outbox.drain([fakeSink(acceptAll)]).catch((e: unknown) => e);
    expect(VetError.isInstance(err)).toBe(true);
    expect(err).toMatchObject({
      code: 'OUTBOX_CORRUPT',
      message: expect.stringContaining('pending.jsonl:2'),
    });
  });

  test('a line whose verdict fails the schema is corrupt', async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'pending.jsonl'),
      `${JSON.stringify({ id: 'x', verdict: { caseId: 1 }, enqueuedAt: 'now' })}\n`,
    );
    await expect(createOutbox(opts()).reconcile()).rejects.toMatchObject({
      code: 'OUTBOX_CORRUPT',
      message: expect.stringContaining('pending.jsonl:1'),
    });
  });

  test('empty pending is a no-op', async () => {
    const sink = fakeSink(acceptAll);
    const [result] = await createOutbox(opts()).drain([sink]);
    expect(sink.calls).toHaveLength(0);
    expect(result).toEqual({
      sink: 'fake',
      sent: 0,
      acknowledged: 0,
      retried: 0,
      dead: 0,
      pending: 0,
    });
  });

  test('sink throw rethrows and acks nothing', async () => {
    const outbox = createOutbox(opts());
    const sink = fakeSink(() => {
      throw new TypeError('bug');
    });
    await outbox.enqueue(verdicts(2));
    await expect(outbox.drain([sink])).rejects.toThrow('bug');
    expect(await lines('acked.jsonl')).toEqual([]);
    expect(await lines('dead.jsonl')).toEqual([]);
  });

  test('a never-resolving, signal-ignoring sink times out and leaves the item pending', async () => {
    const outbox = createOutbox(opts({ timeoutMs: 5 }));
    const sink = fakeSink(() => new Promise<SinkAck>(() => {}));
    await outbox.enqueue(verdicts(1));
    const [result] = await outbox.drain([sink]);
    expect(result).toMatchObject({ acknowledged: 0, dead: 0, pending: 1 });
  });

  test('idempotent:false never resends unlisted ids', async () => {
    const outbox = createOutbox(opts());
    const sink = fakeSink((b) => ({ accepted: ids(b).slice(1), rejected: [] }), {
      idempotent: false,
    });
    await outbox.enqueue(verdicts(2));
    const [result] = await outbox.drain([sink]);
    expect(sink.calls).toHaveLength(1);
    expect(result).toMatchObject({ acknowledged: 1, dead: 1 });
  });

  test('duplicate ids are counted once', async () => {
    const outbox = createOutbox(opts());
    await outbox.enqueue([verdict(0, 'same')]);
    await outbox.enqueue([verdict(0, 'same')]);
    const sink = fakeSink(acceptAll);
    await outbox.drain([sink]);
    expect(sink.calls[0]).toHaveLength(1);
    expect(await outbox.reconcile()).toEqual({ produced: 1, acknowledged: 1, dead: 0 });
  });

  test('lock busy', async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, '.lock'), String(process.pid));
    const err: unknown = await createOutbox(opts())
      .enqueue(verdicts(1))
      .catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: 'E_IO',
      message: expect.stringContaining(`outbox locked by pid ${process.pid}`),
      details: { hint: expect.any(String) },
    });
  });

  test('stale lock', async () => {
    const outbox = createOutbox(opts());
    await outbox.enqueue(verdicts(1));
    await writeFile(join(dir, '.lock'), '99999999');
    const [result] = await outbox.drain([fakeSink(acceptAll)]);
    expect(result).toMatchObject({ acknowledged: 1 });
  });

  test('the lock is released after drain', async () => {
    const outbox = createOutbox(opts());
    await outbox.enqueue(verdicts(1));
    await outbox.drain([fakeSink(acceptAll)]);
    await expect(readFile(join(dir, '.lock'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
