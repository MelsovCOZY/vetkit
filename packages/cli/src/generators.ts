// GeneratorV1 from a declarative GeneratorEndpoint. The key is read by env
// var name only; the structured default ('json_schema') lives here, so core's ResolvedConfig
// stays an exact echo of the user's config.
import { readEnvName } from '@vetkit/core';
import { createOpenAICompatibleGenerator } from '@vetkit/generator-openai-compatible';
import { CEV_ERROR_CODES, VetError, type GeneratorEndpoint, type GeneratorV1 } from '@vetkit/spec';

// Names a wire protocol, not a vendor.
const GENERATOR_KIND = 'openai-compatible';

export interface GeneratorFromEndpointOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
}

export function generatorFromEndpoint(
  endpoint: GeneratorEndpoint,
  options: GeneratorFromEndpointOptions = {},
): GeneratorV1 {
  if (endpoint.kind !== GENERATOR_KIND) {
    throw new VetError(
      CEV_ERROR_CODES.CONFIG_INVALID,
      `generator kind '${endpoint.kind}' is not supported; expected '${GENERATOR_KIND}'`,
    );
  }
  // A registry-resolved generator is judgeEndpoint-shaped and may lack these (core casts it).
  if (
    typeof endpoint.baseURL !== 'string' ||
    endpoint.baseURL === '' ||
    typeof endpoint.model !== 'string' ||
    endpoint.model === ''
  ) {
    throw new VetError(
      CEV_ERROR_CODES.CONFIG_INVALID,
      'generator endpoint needs baseURL and model',
    );
  }
  return createOpenAICompatibleGenerator({
    baseURL: endpoint.baseURL,
    model: endpoint.model,
    apiKey: readEnvName(endpoint.apiKeyEnv, options.env ?? process.env),
    apiKeyEnv: endpoint.apiKeyEnv,
    structured: endpoint.structured ?? 'json_schema',
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}
