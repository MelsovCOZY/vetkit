// `otel/openinference` sink: POSTs one OpenInference EVALUATOR carrier span per verdict as
// OTLP/JSON to an OTLP/HTTP traces endpoint. Sibling of `otel/logs` (log-sink.ts): same
// injected fetch, same status-code -> ack mapping. Rejections are data, never throws.
import {
  defineSink,
  safeParseJson,
  type JsonSchema,
  type SinkAck,
  type SinkV1,
  type Verdict,
} from '@vetkit/spec';
import { byteLength, correlationProblem, MAX_BODY_BYTES } from './encode.ts';
import { encodeTracesBody, verdictToSpan } from './encode-span.ts';

const DEFAULT_TIMEOUT_MS = 10_000;
const TRACES_PATH = '/v1/traces';
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

export interface CreateOpenInferenceSinkOptions {
  readonly endpoint: string;
  readonly headers?: Record<string, string>;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

interface ExportTraceResponse {
  partialSuccess?: { rejectedSpans?: number | string; errorMessage?: string };
}

const RESPONSE_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    partialSuccess: {
      type: 'object',
      properties: {
        rejectedSpans: { anyOf: [{ type: 'integer' }, { type: 'string' }] },
        errorMessage: { type: 'string' },
      },
    },
  },
};

type Entry = { id: string; verdict: Verdict };

function resolveUrl(endpoint: string): string {
  const url = new URL(endpoint);
  if (url.pathname === '/' || url.pathname === '') url.pathname = TRACES_PATH;
  return url.toString();
}

function rejectAll(entries: Entry[], reason: string, retryable: boolean): SinkAck {
  return { accepted: [], rejected: entries.map(({ id }) => ({ id, reason, retryable })) };
}

function mergeAcks(a: SinkAck, b: SinkAck): SinkAck {
  return { accepted: [...a.accepted, ...b.accepted], rejected: [...a.rejected, ...b.rejected] };
}

function rejectedCount(text: string): number {
  if (text.trim() === '') return 0;
  const parsed = safeParseJson<ExportTraceResponse>(text, RESPONSE_SCHEMA);
  if (!parsed.ok) return 0;
  const count = Number(parsed.value.partialSuccess?.rejectedSpans ?? 0);
  return Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0;
}

// A span link needs both ids, so the responseId fallback of the log sink does not apply here.
function linkProblem(verdict: Verdict): string | undefined {
  const { traceId, spanId } = verdict.provenance ?? {};
  if (traceId === undefined || spanId === undefined) return 'no correlation id';
  return correlationProblem(verdict);
}

export function createOpenInferenceSink(opts: CreateOpenInferenceSinkOptions): SinkV1 {
  const url = resolveUrl(opts.endpoint);
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function post(entries: Entry[], signal: AbortSignal | undefined): Promise<SinkAck> {
    const body = encodeTracesBody(entries.map(({ verdict }) => verdictToSpan(verdict)));
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

    // OTLP does not say which spans were rejected; the last N are reported retryable (the
    // sink is idempotent at the verdict level: a resend adds a second carrier, same identifier).
    const rejected = Math.min(rejectedCount(text), entries.length);
    const keep = entries.length - rejected;
    return mergeAcks(
      { accepted: entries.slice(0, keep).map(({ id }) => id), rejected: [] },
      rejectAll(entries.slice(keep), 'SINK_REJECTED', true),
    );
  }

  return defineSink({
    specVersion: 'v1',
    id: 'otel/openinference',
    capabilities: { batch: 200, idempotent: true },
    async doWrite(batch, { signal }) {
      const ack: SinkAck = { accepted: [], rejected: [] };
      const sendable: Entry[] = [];
      for (const verdict of batch) {
        const id = verdict.id ?? '';
        const problem = linkProblem(verdict);
        if (problem === undefined) sendable.push({ id, verdict });
        else ack.rejected.push({ id, reason: problem, retryable: false });
      }
      if (sendable.length === 0) return ack;
      return mergeAcks(ack, await post(sendable, signal));
    },
  });
}
