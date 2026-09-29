// Source port: reads traces from an observability backend or file into the NormalizedTrace
// IR. Mirrors SinkV1: a hand-written port interface with no
// kind field. defineSource checks specVersion only: it does not call
// defineAdapter, and does no freeze, marker or id-shape check.

import type { NormalizedTrace } from '../generated/index.ts';
import { assertSpecVersion } from '../registry.ts';

export interface SourceV1 {
  specVersion: 'v1';
  id: string;
  capabilities: { streaming: boolean; content: 'captured' | 'maybe' | 'never' };
  doRead(opts: { signal?: AbortSignal }): AsyncIterable<NormalizedTrace>;
}

export function defineSource(x: SourceV1): SourceV1 {
  assertSpecVersion({
    specVersion: x.specVersion,
    id: x.id,
    kind: 'source',
    capabilities: x.capabilities,
  });
  return x;
}
