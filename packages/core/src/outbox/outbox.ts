// Durable file-backed outbox: verdicts are appended to pending.jsonl before any
// sink call; each sink's outcome is appended to acked.jsonl or dead.jsonl with the sink id.
// Files are never rewritten: what a sink still owes is pending minus its acked and dead ids.
// Retry policy lives here, not in sinks. Only non-retryable rejections are dead-lettered; a
// retryable item that exhausts its attempts gets no line and stays pending for the next
// drain (a down collector leaves items pending; the next run drains them).
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  CEV_ERROR_CODES,
  validateJson,
  verdictSchema,
  VetError,
  type JsonSchema,
  type SinkV1,
  type Verdict,
} from '@vetkit/spec';
import { backoffDelay } from './backoff.ts';
import { appendLines, scanLines, withLock } from './files.ts';

export interface OutboxOptions {
  readonly dir: string;
  // Per-doWrite AbortSignal.timeout, default 30_000.
  readonly timeoutMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
}

// `sink` is SinkV1.id. For a per-sink summary, rejected = dead + pending.
export interface DrainResult {
  readonly sink: string;
  // Items passed to doWrite, counting resends and split retries.
  readonly sent: number;
  readonly acknowledged: number;
  // Items resent after a backoff wait.
  readonly retried: number;
  readonly dead: number;
  // Retryable items still unacknowledged after the last attempt; kept for the next drain.
  readonly pending: number;
}

export interface ReconcileResult {
  readonly produced: number;
  readonly acknowledged: number;
  readonly dead: number;
}

export interface Outbox {
  // `targets` are the sink ids this run writes to; reconcile counts only those for these items.
  // Without it (and for items written before targets existed) every configured sink is owed.
  enqueue(verdicts: readonly Verdict[], opts?: { targets?: readonly string[] }): Promise<string[]>;
  drain(sinks: readonly SinkV1[]): Promise<DrainResult[]>;
  // An id is acknowledged when every sink it targets acked (or skipped) it, dead when any of
  // them dead-lettered it. An item without targets uses `sinks`, else the sinks seen in
  // acked/dead.
  reconcile(opts?: { sinks?: readonly string[] }): Promise<ReconcileResult>;
}

interface PendingLine {
  id: string;
  verdict: Verdict;
  enqueuedAt: string;
  targets?: string[];
}
interface AckedLine {
  id: string;
  sink: string;
  at: string;
  skipped?: boolean;
}
interface DeadLine {
  id: string;
  sink: string;
  reason: string;
  at: string;
}

const pendingSchema: JsonSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    verdict: { type: 'object' },
    enqueuedAt: { type: 'string' },
    targets: { type: 'array', items: { type: 'string' } },
  },
  required: ['id', 'verdict', 'enqueuedAt'],
};
const ackedSchema: JsonSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    sink: { type: 'string' },
    at: { type: 'string' },
    skipped: { type: 'boolean' },
  },
  required: ['id', 'sink', 'at'],
};
const deadSchema: JsonSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    sink: { type: 'string' },
    reason: { type: 'string' },
    at: { type: 'string' },
  },
  required: ['id', 'sink', 'reason', 'at'],
};

const MAX_ATTEMPTS = 3;
// A sink declines a verdict on purpose by rejecting it, non-retryable, with a reason starting
// with this prefix (the SinkAck shape has no skipped field). It is a terminal ack, not dead.
const SKIPPED_PREFIX = 'skipped:';

function checkVerdict(line: PendingLine): VetError | undefined {
  const res = validateJson<Verdict>(line.verdict, verdictSchema);
  return res.ok ? undefined : res.error;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

interface BatchOutcome {
  accepted: string[];
  skipped: string[];
  dead: Array<{ id: string; reason: string }>;
  retry: PendingLine[];
  sent: number;
}

function deadAll(batch: PendingLine[], err: VetError): Array<{ id: string; reason: string }> {
  return batch.map((p) => ({ id: p.id, reason: `${err.code}: ${err.message}` }));
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && err.name === 'TimeoutError';
}

// Races `promise` against `signal`, so a sink that ignores its AbortSignal and never
// resolves still returns (as a rejection) once the signal fires. Same pattern as
// fetchWithAbort in packages/judge-jev/src/transport.ts.
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (cause: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(cause);
      },
    );
  });
}

// A thrown error is a whole-batch outcome: SINK_* VetErrors and timeouts are rejections,
// anything else is a programmer error and is rethrown with nothing recorded for the batch.
function thrownOutcome(err: unknown, batch: PendingLine[]): BatchOutcome {
  const all = (reason: string, retryable: boolean): BatchOutcome => ({
    accepted: [],
    skipped: [],
    dead: retryable ? [] : batch.map((p) => ({ id: p.id, reason })),
    retry: retryable ? batch : [],
    sent: batch.length,
  });
  if (isTimeout(err)) return all('timeout', true);
  if (VetError.isInstance(err) && err.code.startsWith('SINK_')) {
    const retryable = err.details?.retryable ?? err.code === CEV_ERROR_CODES.SINK_UNREACHABLE;
    return all(`${err.code}: ${err.message}`, retryable);
  }
  throw err;
}

export function createOutbox(opts: OutboxOptions): Outbox {
  const { dir } = opts;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;
  const pendingFile = join(dir, 'pending.jsonl');
  const ackedFile = join(dir, 'acked.jsonl');
  const deadFile = join(dir, 'dead.jsonl');

  async function scanPending(): Promise<PendingLine[]> {
    const seen = new Set<string>();
    const out: PendingLine[] = [];
    for (const line of await scanLines<PendingLine>(pendingFile, pendingSchema, checkVerdict)) {
      if (seen.has(line.id)) continue;
      seen.add(line.id);
      out.push(line);
    }
    return out;
  }

  async function sendBatch(sink: SinkV1, batch: PendingLine[]): Promise<BatchOutcome> {
    let ack;
    try {
      const signal = AbortSignal.timeout(timeoutMs);
      ack = await raceAbort(
        sink.doWrite(
          batch.map((p) => p.verdict),
          { signal },
        ),
        signal,
      );
    } catch (err) {
      if (VetError.isInstance(err) && err.code === CEV_ERROR_CODES.SINK_PAYLOAD_TOO_LARGE) {
        if (batch.length === 1) {
          return { accepted: [], skipped: [], dead: deadAll(batch, err), retry: [], sent: 1 };
        }
        const half = Math.ceil(batch.length / 2);
        const a = await sendBatch(sink, batch.slice(0, half));
        const b = await sendBatch(sink, batch.slice(half));
        return {
          accepted: [...a.accepted, ...b.accepted],
          skipped: [...a.skipped, ...b.skipped],
          dead: [...a.dead, ...b.dead],
          retry: [...a.retry, ...b.retry],
          sent: batch.length + a.sent + b.sent,
        };
      }
      return thrownOutcome(err, batch);
    }
    const inBatch = new Set(batch.map((p) => p.id));
    const accepted = new Set(ack.accepted.filter((id) => inBatch.has(id)));
    const rejected = new Map(ack.rejected.filter((r) => inBatch.has(r.id)).map((r) => [r.id, r]));
    const out: BatchOutcome = {
      accepted: [...accepted],
      skipped: [],
      dead: [],
      retry: [],
      sent: batch.length,
    };
    for (const p of batch) {
      if (accepted.has(p.id)) continue;
      const r = rejected.get(p.id);
      if (r === undefined) {
        // Unlisted: an idempotent sink can take it again; a non-idempotent one never does.
        if (sink.capabilities.idempotent) out.retry.push(p);
        else out.dead.push({ id: p.id, reason: 'unacknowledged by non-idempotent sink' });
      } else if (!r.retryable && r.reason.startsWith(SKIPPED_PREFIX)) {
        out.skipped.push(p.id);
      } else if (r.retryable) {
        out.retry.push(p);
      } else {
        out.dead.push({ id: p.id, reason: r.reason });
      }
    }
    return out;
  }

  async function drainSink(sink: SinkV1, pending: PendingLine[]): Promise<DrainResult> {
    let sent = 0;
    let acknowledged = 0;
    let retried = 0;
    let dead = 0;
    let queue = pending;
    for (let attempt = 0; attempt < MAX_ATTEMPTS && queue.length > 0; attempt++) {
      if (attempt > 0) {
        await sleep(backoffDelay(attempt - 1, random));
        retried += queue.length;
      }
      const next: PendingLine[] = [];
      for (const batch of chunk(queue, sink.capabilities.batch)) {
        const outcome = await sendBatch(sink, batch);
        const at = new Date().toISOString();
        await appendLines(ackedFile, [
          ...outcome.accepted.map((id): AckedLine => ({ id, sink: sink.id, at })),
          ...outcome.skipped.map((id): AckedLine => ({ id, sink: sink.id, at, skipped: true })),
        ]);
        await appendLines(
          deadFile,
          outcome.dead.map((d): DeadLine => ({ ...d, sink: sink.id, at })),
        );
        sent += outcome.sent;
        // A skipped item is a terminal ack, counted with the accepted ones.
        acknowledged += outcome.accepted.length + outcome.skipped.length;
        dead += outcome.dead.length;
        next.push(...outcome.retry);
      }
      queue = next;
    }
    return { sink: sink.id, sent, acknowledged, retried, dead, pending: queue.length };
  }

  return {
    enqueue(verdicts, enqueueOpts) {
      return withLock(dir, async () => {
        const enqueuedAt = new Date().toISOString();
        const lines = verdicts.map((v): PendingLine => {
          const id = v.id ?? randomUUID();
          return {
            id,
            verdict: { ...v, id },
            enqueuedAt,
            ...(enqueueOpts?.targets === undefined ? {} : { targets: [...enqueueOpts.targets] }),
          };
        });
        await appendLines(pendingFile, lines);
        return lines.map((l) => l.id);
      });
    },

    drain(sinks) {
      return withLock(dir, async () => {
        const pending = await scanPending();
        const acked = await scanLines<AckedLine>(ackedFile, ackedSchema);
        const deadLines = await scanLines<DeadLine>(deadFile, deadSchema);
        const results: DrainResult[] = [];
        for (const sink of sinks) {
          const done = new Set(
            [...acked, ...deadLines].filter((l) => l.sink === sink.id).map((l) => l.id),
          );
          results.push(
            await drainSink(
              sink,
              pending.filter(
                (p) => !done.has(p.id) && (p.targets === undefined || p.targets.includes(sink.id)),
              ),
            ),
          );
        }
        return results;
      });
    },

    async reconcile(options) {
      const pending = await scanPending();
      const acked = await scanLines<AckedLine>(ackedFile, ackedSchema);
      const deadLines = await scanLines<DeadLine>(deadFile, deadSchema);
      const configured = options?.sinks ?? [
        ...new Set([...acked, ...deadLines].map((l) => l.sink)),
      ];
      const ackedBy = new Set(acked.map((l) => `${l.sink}\u0000${l.id}`));
      const deadBy = new Set(deadLines.map((l) => `${l.sink}\u0000${l.id}`));
      let acknowledged = 0;
      let dead = 0;
      for (const { id, targets } of pending) {
        const sinks = targets ?? configured;
        if (sinks.some((s) => deadBy.has(`${s}\u0000${id}`))) dead++;
        else if (sinks.length > 0 && sinks.every((s) => ackedBy.has(`${s}\u0000${id}`))) {
          acknowledged++;
        }
      }
      return { produced: pending.length, acknowledged, dead };
    },
  };
}
