// Langfuse sink: one POST <baseUrl>/api/public/scores per verdict.
// Raw fetch, no langfuse package. Rejection reasons carry only a code and an HTTP status, never
// headers, bodies or keys. Retries belong to the outbox; scores are not idempotent.

import { createHash } from 'node:crypto';
import { CEV_ERROR_CODES, defineSink } from '@vetkit/spec';
import type { SinkAck, SinkV1, Verdict } from '@vetkit/spec';
import { toLangfuseScore } from './map.ts';

export interface LangfuseSinkOptions {
  baseUrl: string;
  publicKey: string;
  secretKey: string;
  fetch?: typeof fetch;
  // Whole-request deadline per POST; defaults to 10 s.
  timeoutMs?: number;
}

type Rejection = SinkAck['rejected'][number];

// Duplicated (not imported) status → ack mapping: adapters import only @vetkit/spec.
function rejectionFor(id: string, status: number): Rejection {
  if (status === 401 || status === 403) {
    return { id, reason: `${CEV_ERROR_CODES.SINK_AUTH}: HTTP ${status}`, retryable: false };
  }
  if (status === 413) {
    return {
      id,
      reason: `${CEV_ERROR_CODES.SINK_PAYLOAD_TOO_LARGE}: HTTP ${status}`,
      retryable: false,
    };
  }
  if (status === 429 || status >= 500) {
    return { id, reason: `${CEV_ERROR_CODES.SINK_UNREACHABLE}: HTTP ${status}`, retryable: true };
  }
  return { id, reason: `${CEV_ERROR_CODES.SINK_REJECTED}: HTTP ${status}`, retryable: false };
}

// Deterministic score id, so a rerun of the same verdict upserts instead of duplicating: the
// observation (else trace), criterion, case and the judged outcome. Not the verdict id, which
// is fresh on every run.
function scoreId(verdict: Verdict, traceId: string): string {
  const target = verdict.provenance?.observationId ?? traceId;
  const identity = JSON.stringify([
    target,
    verdict.criterionId,
    verdict.caseId,
    verdict.model.resolved,
    verdict.answer ?? null,
  ]);
  return createHash('sha256').update(identity).digest('hex').slice(0, 32);
}

export function createLangfuseSink(options: LangfuseSinkOptions): SinkV1 {
  const doFetch = options.fetch ?? fetch;
  const url = `${options.baseUrl.replace(/\/+$/, '')}/api/public/scores`;
  const authorization = `Basic ${Buffer.from(`${options.publicKey}:${options.secretKey}`).toString('base64')}`;
  const timeoutMs = options.timeoutMs ?? 10_000;

  async function post(
    id: string,
    verdict: Verdict,
    signal?: AbortSignal,
  ): Promise<Rejection | 'skipped' | undefined> {
    const traceId = verdict.provenance?.traceId;
    if (traceId === undefined) return { id, reason: 'no correlation id', retryable: false };
    const score = toLangfuseScore(verdict, traceId);
    if (score === undefined) return 'skipped';
    const deadline = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await doFetch(url, {
        method: 'POST',
        headers: { authorization, 'content-type': 'application/json' },
        body: JSON.stringify({ id: scoreId(verdict, traceId), ...score }),
        signal: signal === undefined ? deadline : AbortSignal.any([signal, deadline]),
      });
    } catch {
      return { id, reason: `${CEV_ERROR_CODES.SINK_UNREACHABLE}: network error`, retryable: true };
    }
    await response.body?.cancel();
    return response.ok ? undefined : rejectionFor(id, response.status);
  }

  return defineSink({
    specVersion: 'v1',
    id: 'langfuse/scores',
    capabilities: { batch: 50, idempotent: false },
    async doWrite(batch, opts) {
      const ack: SinkAck = { accepted: [], rejected: [] };
      const skipped: NonNullable<SinkAck['skipped']> = [];
      for (const verdict of batch) {
        const id = verdict.id ?? `${verdict.caseId}:${verdict.criterionId}`;
        if (verdict.status !== 'ok') {
          skipped.push({ id, reason: `unscored:${verdict.status}` });
          continue;
        }
        const rejection = await post(id, verdict, opts.signal);
        if (rejection === undefined) ack.accepted.push(id);
        else if (rejection === 'skipped') skipped.push({ id, reason: 'unscored:no_answer' });
        else ack.rejected.push(rejection);
      }
      return skipped.length === 0 ? ack : { ...ack, skipped };
    },
  });
}
