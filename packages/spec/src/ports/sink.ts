// Sink port: writes verdicts back to an observability backend.
// Mirrors JudgeV1/ExporterV1: a hand-written port interface with no kind field. defineSink
// checks specVersion and that capabilities.batch is a positive integer:
// no defineAdapter, no freeze, no marker, no id-shape check ('otel/logs' ok).

import { CEV_ERROR_CODES, VetError } from '../errors.ts';
import type { Verdict } from '../generated/index.ts';
import { assertSpecVersion } from '../registry.ts';

// accepted and rejected[].id are Verdict.id values from the batch passed to doWrite.
export interface SinkAck {
  accepted: string[];
  rejected: Array<{ id: string; reason: string; retryable: boolean }>;
}

export interface SinkV1 {
  specVersion: 'v1';
  id: string;
  capabilities: { batch: number; idempotent: boolean };
  doWrite(batch: Verdict[], opts: { signal?: AbortSignal }): Promise<SinkAck>;
}

export function defineSink(x: SinkV1): SinkV1 {
  assertSpecVersion({
    specVersion: x.specVersion,
    id: x.id,
    kind: 'sink',
    capabilities: x.capabilities,
  });
  const { batch } = x.capabilities;
  if (!Number.isInteger(batch) || batch < 1) {
    throw new VetError(
      CEV_ERROR_CODES.E_ADAPTER_CAPABILITY,
      `Sink "${x.id}" has capabilities.batch ${String(batch)}, expected an integer >= 1`,
    );
  }
  return x;
}
