// generated — do not edit

export type PluginRef =
  | string
  | {
      specVersion: 'v1';
      id: string;
    };
export type SinkRef = PluginRef | OtelSinkDescriptor | LangfuseSinkDescriptor;

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
    [k: string]: JudgeEndpoint | GeneratorEndpoint | AdapterRef;
  };
  /**
   * Trace sources: opaque names or source adapter objects.
   */
  sources?: PluginRef[];
  /**
   * Result sinks: opaque names, sink adapter objects, or {kind,*Env} descriptors resolved by the CLI.
   */
  sinks?: SinkRef[];
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
  /**
   * Judge request format; 'raw' when omitted.
   */
  requestFormat?: 'raw' | 'fenced-v1';
  providerOptions?: {
    [k: string]: unknown;
  };
}
export interface OtelSinkDescriptor {
  kind: 'otel';
  endpoint: string;
  /**
   * Name of the env var holding the OTLP headers (OTEL_EXPORTER_OTLP_HEADERS syntax: k=v,k2=v2).
   */
  headersEnv?: string;
}
export interface LangfuseSinkDescriptor {
  kind: 'langfuse';
  /**
   * Name of the env var holding the Langfuse base URL.
   */
  baseUrlEnv: string;
  /**
   * Name of the env var holding the Langfuse public key.
   */
  publicKeyEnv: string;
  /**
   * Name of the env var holding the Langfuse secret key.
   */
  secretKeyEnv: string;
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
