// `otel/logs` sink: POSTs one gen_ai.evaluation.result LogRecord per verdict as OTLP/JSON to
// an OTLP/HTTP logs endpoint. Injected fetch, no SDK pipeline.
// Rejections are data: HTTP and network failures map to ack entries, never throws.
import {
  defineSink,
  safeParseJson,
  type JsonSchema,
  type SinkAck,
  type SinkV1,
} from '@vetkit/spec';
import {
  byteLength,
  correlationProblem,
  encodeLogsBody,
  MAX_BODY_BYTES,
  verdictToLogRecord,
} from './encode.ts';
import { mergeAcks, rejectAll, resolveUrl, statusToAck, type Entry } from './sink-shared.ts';

const DEFAULT_TIMEOUT_MS = 10_000;
const LOGS_PATH = '/v1/logs';

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

function rejectedCount(text: string): number {
  if (text.trim() === '') return 0;
  const parsed = safeParseJson<ExportLogsResponse>(text, RESPONSE_SCHEMA);
  if (!parsed.ok) return 0;
  const count = Number(parsed.value.partialSuccess?.rejectedLogRecords ?? 0);
  return Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0;
}

export function createOtelSink(opts: CreateOtelSinkOptions): SinkV1 {
  const url = resolveUrl(opts.endpoint, LOGS_PATH);
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
    const failure = statusToAck(status, entries);
    if (failure !== undefined) return failure;

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
