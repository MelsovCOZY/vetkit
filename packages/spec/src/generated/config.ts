// generated — do not edit

export type PluginRef =
  | string
  | {
      specVersion: 'v1';
      id: string;
    };

/**
 * Declarative shape of vetkit.config.ts. Adapter objects are checked as {specVersion, id, capabilities} projections; their methods are checked structurally in core.
 */
export interface ConfigDoc {
  /**
   * Generator LLM: a registry name, an endpoint, or a generator adapter object. Optional; no implicit default.
   */
  generator?: string | GeneratorEndpoint | AdapterRef;
  /**
   * Judge: a registry name, an endpoint, or a JudgeV1 adapter object. Required; never defaulted.
   */
  judge: string | JudgeEndpoint | AdapterRef;
  /**
   * User-declared map from name to endpoint or adapter object; the only way a string judge/generator resolves.
   */
  registry?: {
    [k: string]: JudgeEndpoint | AdapterRef;
  };
  /**
   * Trace sources: opaque names or source adapter objects.
   */
  sources?: PluginRef[];
  /**
   * Result sinks: opaque names or sink adapter objects.
   */
  sinks?: PluginRef[];
  thresholds?: ThresholdsPolicy;
  watch?: WatchConfig;
  gate?: GateConfig;
  /**
   * Verdict cache directory; defaults to '.vet'.
   */
  cacheDir?: string;
}
export interface GeneratorEndpoint {
  /**
   * Transport kind, validated by the adapter.
   */
  kind: string;
  baseURL: string;
  /**
   * Name of the env var holding the key.
   */
  apiKeyEnv: string;
  model: string;
  /**
   * Structured-output strategy; missing means json_schema.
   */
  structured?: 'json_schema' | 'json_object' | 'prompt';
}
export interface AdapterRef {
  specVersion: 'v1';
  id: string;
  capabilities: {
    [k: string]: unknown;
  };
}
/**
 * Either preset, or baseURL and model, is required; core enforces this (a schema anyOf would degrade the generated type).
 */
export interface JudgeEndpoint {
  /**
   * Transport kind, validated by the adapter.
   */
  kind: string;
  /**
   * Opaque preset name; the adapter validates it and supplies baseURL and model defaults.
   */
  preset?: string;
  /**
   * Account id some presets need in their URL.
   */
  accountId?: string;
  baseURL?: string;
  /**
   * Name of the env var holding the key.
   */
  apiKeyEnv: string;
  model?: string;
  providerOptions?: {
    [k: string]: unknown;
  };
}
export interface ThresholdsPolicy {
  /**
   * Pass threshold for every criterion; defaults to 0.5, a placeholder until calibrated.
   */
  default?: number;
  /**
   * Per-criterion overrides keyed by criterion id.
   */
  perCriterion?: {
    [k: string]: number;
  };
}
/**
 * Sampling for watch mode.
 */
export interface WatchConfig {
  sampleRate?: number;
  upstreamSampleRate?: number;
  /**
   * Concurrent judge calls in watch mode; defaults to 4.
   */
  maxInFlight?: number;
}
export interface GateConfig {
  minPass?: number;
  /**
   * Refuse to gate on uncalibrated criteria; defaults to true.
   */
  requireCalibrated?: boolean;
  /**
   * Allow gating on an unpinned judge model; defaults to false.
   */
  allowUnpinned?: boolean;
}
