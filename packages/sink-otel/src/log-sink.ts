// `otel/logs` sink: POSTs one gen_ai.evaluation.result LogRecord per verdict as OTLP/JSON to
// an OTLP/HTTP logs endpoint. Injected fetch, no SDK pipeline (root DECISION: access layer).
// Rejections are data: HTTP and network failures map to ack entries, never throws.
import {
  defineSink,
  safeParseJson,
  type JsonSchema,
  type SinkAck,
  type SinkV1,
} from '@vetkit/spec';
import type { Verdict } from '@vetkit/spec';
import {
  byteLength,
  correlationProblem,
  encodeLogsBody,
  MAX_BODY_BYTES,
  verdictToLogRecord,
} from './encode.ts';

const DEFAULT_TIMEOUT_MS = 10_000;
const LOGS_PATH = '/v1/logs';
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

export interface CreateOtelSinkOptions {
  readonly endpoint: string;
  readonly headers?: Record<string, string>;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

interface ExportLogsResponse {
  partialSuccess?: { rejectedLogRecords?: number | string; errorMessage?: string };
}

// OTLP/JSON encodes int64 as a string, but some servers send a number.
const RESPONSE_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    partialSuccess: {
      type: 'object',
      properties: {
        rejectedLogRecords: { anyOf: [{ type: 'integer' }, { type: 'string' }] },
        errorMessage: { type: 'string' },
      },
    },
  },
};

function resolveUrl(endpoint: string): string {
  const url = new URL(endpoint);
  if (url.pathname === '/' || url.pathname === '') url.pathname = LOGS_PATH;
  return url.toString();
}

type Entry = { id: string; verdict: Verdict };

function rejectAll(entries: Entry[], reason: string, retryable: boolean): SinkAck {
  return { accepted: [], rejected: entries.map(({ id }) => ({ id, reason, retryable })) };
}

function mergeAcks(a: SinkAck, b: SinkAck): SinkAck {
  return { accepted: [...a.accepted, ...b.accepted], rejected: [...a.rejected, ...b.rejected] };
}

function rejectedCount(text: string): number {
  if (text.trim() === '') return 0;
  const parsed = safeParseJson<ExportLogsResponse>(text, RESPONSE_SCHEMA);
  if (!parsed.ok) return 0;
  const count = Number(parsed.value.partialSuccess?.rejectedLogRecords ?? 0);
  return Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0;
}

export function createOtelSink(opts: CreateOtelSinkOptions): SinkV1 {
  const url = resolveUrl(opts.endpoint);
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function post(entries: Entry[], signal: AbortSignal | undefined): Promise<SinkAck> {
    const body = encodeLogsBody(entries.map(({ verdict }) => verdictToLogRecord(verdict)));
    if (byteLength(body) > MAX_BODY_BYTES) {
      if (entries.length === 1) return rejectAll(entries, 'SINK_PAYLOAD_TOO_LARGE', false);
      const mid = Math.ceil(entries.length / 2);
      const first = await post(entries.slice(0, mid), signal);
      return mergeAcks(first, await post(entries.slice(mid), signal));
    }

    const deadline = AbortSignal.timeout(timeoutMs);
    let response: Response;
    let text: string;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { ...opts.headers, 'content-type': 'application/json' },
        body,
        signal: signal === undefined ? deadline : AbortSignal.any([signal, deadline]),
      });
      text = await response.text();
    } catch {
      return rejectAll(entries, 'SINK_UNREACHABLE:network', true);
    }

    const { status } = response;
    if (status === 401 || status === 403) return rejectAll(entries, 'SINK_AUTH', false);
    if (RETRYABLE_STATUS.has(status)) return rejectAll(entries, `SINK_UNREACHABLE:${status}`, true);
    if (status === 413) return rejectAll(entries, 'SINK_PAYLOAD_TOO_LARGE', true);
    if (status < 200 || status >= 300) return rejectAll(entries, `SINK_REJECTED:${status}`, false);

    // OTLP does not say which records were rejected, so the last N are reported retryable;
    // the sink is idempotent, so a retry of an already-stored record is harmless.
    const rejected = Math.min(rejectedCount(text), entries.length);
    const keep = entries.length - rejected;
    return mergeAcks(
      { accepted: entries.slice(0, keep).map(({ id }) => id), rejected: [] },
      rejectAll(entries.slice(keep), 'SINK_REJECTED', true),
    );
  }

  return defineSink({
    specVersion: 'v1',
    id: 'otel/logs',
    capabilities: { batch: 200, idempotent: true },
    async doWrite(batch, { signal }) {
      const ack: SinkAck = { accepted: [], rejected: [] };
      const sendable: Entry[] = [];
      for (const verdict of batch) {
        const id = verdict.id ?? '';
        const problem = correlationProblem(verdict);
        if (problem === undefined) sendable.push({ id, verdict });
        else ack.rejected.push({ id, reason: problem, retryable: false });
      }
      if (sendable.length === 0) return ack;
      return mergeAcks(ack, await post(sendable, signal));
    },
  });
}
