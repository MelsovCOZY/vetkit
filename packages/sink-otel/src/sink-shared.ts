// Internals shared by the `otel/logs` and `otel/openinference` sinks so their ack semantics
// cannot drift. Not re-exported from index.ts.
import type { SinkAck, Verdict } from '@vetkit/spec';

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

export type Entry = { id: string; verdict: Verdict };

export function rejectAll(entries: Entry[], reason: string, retryable: boolean): SinkAck {
  return { accepted: [], rejected: entries.map(({ id }) => ({ id, reason, retryable })) };
}

export function mergeAcks(a: SinkAck, b: SinkAck): SinkAck {
  return { accepted: [...a.accepted, ...b.accepted], rejected: [...a.rejected, ...b.rejected] };
}

export function resolveUrl(endpoint: string, defaultPath: string): string {
  const url = new URL(endpoint);
  if (url.pathname === '/' || url.pathname === '') url.pathname = defaultPath;
  return url.toString();
}

// Undefined for 2xx: the caller then inspects the body for partial success.
export function statusToAck(status: number, entries: Entry[]): SinkAck | undefined {
  if (status === 401 || status === 403) return rejectAll(entries, 'SINK_AUTH', false);
  if (RETRYABLE_STATUS.has(status)) return rejectAll(entries, `SINK_UNREACHABLE:${status}`, true);
  if (status === 413) return rejectAll(entries, 'SINK_PAYLOAD_TOO_LARGE', true);
  if (status < 200 || status >= 300) return rejectAll(entries, `SINK_REJECTED:${status}`, false);
  return undefined;
}
