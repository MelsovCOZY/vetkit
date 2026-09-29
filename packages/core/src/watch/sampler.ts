// Pure hashToUnit + a small factory, no class.
//
// The inclusion record is appended with fs.appendFileSync (one small JSONL line per decide()
// call): decide() is synchronous by contract, and a crash right after the sampling decision
// must still leave the record on disk, so an async, batched appender (packages/core/src/outbox/
// files.ts's appendLines) is not used here.
import { appendFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { CEV_ERROR_CODES, VetError, type NormalizedTrace } from '@vetkit/spec';
import type { InclusionRecord, WatchOptions } from './types.ts';

/**
 * The first 8 bytes of sha256(traceId), read as a big-endian uint64, divided by 2^64.
 * Deterministic across restarts and processes — no in-memory random state to lose.
 */
export function hashToUnit(traceId: string): number {
  const digest = createHash('sha256').update(traceId).digest();
  const hi64 = digest.readBigUInt64BE(0);
  return Number(hi64) / 2 ** 64;
}

export interface Sampler {
  decide(trace: NormalizedTrace): { sampled: boolean; record: InclusionRecord };
}

export type SamplerOptions = Pick<
  WatchOptions,
  'sampleRate' | 'upstreamSampleRate' | 'inclusionPath'
>;

export function createSampler(options: SamplerOptions): Sampler {
  const { sampleRate, upstreamSampleRate, inclusionPath } = options;
  if (!(sampleRate >= 0 && sampleRate <= 1)) {
    throw new VetError(
      CEV_ERROR_CODES.WATCH_CONFIG,
      `sampleRate must be within 0..1, got ${sampleRate}`,
    );
  }
  mkdirSync(dirname(inclusionPath), { recursive: true });

  return {
    decide(trace) {
      const upstreamRate: number | 'unknown' = upstreamSampleRate ?? 'unknown';
      const inclusionProbability: number | 'unknown' =
        upstreamSampleRate === undefined ? 'unknown' : upstreamSampleRate * sampleRate;

      let reason: InclusionRecord['reason'];
      let sampled: boolean;
      if (trace.traceId === '' || trace.completeness.missingParents) {
        reason = 'filtered:incomplete';
        sampled = false;
      } else if (!trace.completeness.contentCaptured) {
        reason = 'filtered:no_content';
        sampled = false;
      } else {
        reason = 'rate';
        sampled = hashToUnit(trace.traceId) < sampleRate;
      }

      const record: InclusionRecord = {
        traceId: trace.traceId,
        at: new Date().toISOString(),
        sampled,
        reason,
        evaluatorRate: sampleRate,
        upstreamRate,
        inclusionProbability,
      };

      appendFileSync(inclusionPath, `${JSON.stringify(record)}\n`, 'utf8');
      return { sampled, record };
    },
  };
}
