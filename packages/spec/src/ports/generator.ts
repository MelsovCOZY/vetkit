// Generator port: any chat model that drafts text or structured output. The structured strategy is read from the declared capability, never detected at
// runtime; callers re-validate `value` against the requested schema. defineGenerator checks
// specVersion only: no defineAdapter, no freeze, no marker.

import type { JsonSchema } from '../json.ts';
import { assertSpecVersion } from '../registry.ts';

export interface GeneratorV1 {
  specVersion: 'v1';
  id: string;
  capabilities: {
    structured: 'json_schema' | 'json_object' | 'tool' | 'prompt';
    streaming: boolean;
  };
  doGenerate(req: {
    system?: string;
    prompt: string;
    schema?: { name: string; jsonSchema: JsonSchema };
    signal?: AbortSignal;
  }): Promise<{
    value?: unknown;
    text?: string;
    usage?: { inputTokens?: number; outputTokens?: number };
    resolvedModelId?: string;
  }>;
}

export function defineGenerator(x: GeneratorV1): GeneratorV1 {
  assertSpecVersion({
    specVersion: x.specVersion,
    id: x.id,
    kind: 'generator',
    capabilities: x.capabilities,
  });
  return x;
}
