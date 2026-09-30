// Sink resolution for `vet run --sink <names>`. A configured sink is a bare
// string, an adapter object built in vetkit.config.ts or a `{kind,*Env}`
// descriptor this module resolves into a @vetkit/sink-otel / @vetkit/sink-langfuse adapter
// by reading the named env vars. A name matches a ref by
// exact id/kind, else by the id's prefix before '/' when exactly one ref has that prefix
// ('otel' -> 'otel/logs'). A descriptor is named by its `kind` ('otel'), which differs from
// its built sink's outbox id ('otel/logs'), so `--sink otel/logs` will not match an
// `{kind:'otel',...}` descriptor. handleError's JSON drops details, so every message names
// the sink and the configured names itself, and every descriptor error names the *Env
// variable, never its value.
import { readEnvName, type ResolvedConfig } from '@vetkit/core';
import { CEV_ERROR_CODES, defineSink, VetError, type PluginRef, type SinkV1 } from '@vetkit/spec';
import { createLangfuseSink } from '@vetkit/sink-langfuse';
import { createOtelSink } from '@vetkit/sink-otel';

export interface ResolvedSink {
  /** The name as given on the command line; keys the per-sink counts. */
  readonly name: string;
  readonly sink: SinkV1;
}

/** The `kind` values a `{kind,*Env}` descriptor accepts; mirrors the schema's sinkRef. */
export const SINK_DESCRIPTOR_KINDS = ['otel', 'langfuse'] as const;
type SinkDescriptorKind = (typeof SINK_DESCRIPTOR_KINDS)[number];

type SinkRef = ResolvedConfig['sinks'][number];
type SinkDescriptor = Exclude<SinkRef, PluginRef>;
type SinkConfig = Pick<ResolvedConfig, 'sinks'>;

/** The name a ref matches `--sink` by: itself, an adapter object's id, or a descriptor's kind. */
export function sinkRefName(ref: SinkRef): string {
  if (typeof ref === 'string') return ref;
  return 'kind' in ref ? ref.kind : ref.id;
}

export function configuredSinkNames(config: SinkConfig): string[] {
  return config.sinks.map(sinkRefName);
}

function listed(names: readonly string[]): string {
  return names.length === 0 ? '(none)' : names.join(', ');
}

// VetErrorDetails has no sink field, so the message carries the name and the configured list.
function unknownSink(message: string, configured: readonly string[]): VetError {
  return new VetError(
    CEV_ERROR_CODES.CONFIG_UNKNOWN_SINK,
    `${message}; configured: ${listed(configured)}`,
  );
}

function configInvalid(message: string): VetError {
  return new VetError(CEV_ERROR_CODES.CONFIG_INVALID, message);
}

function isSinkShape(ref: object): ref is SinkV1 {
  return (
    'doWrite' in ref &&
    typeof ref.doWrite === 'function' &&
    'capabilities' in ref &&
    typeof ref.capabilities === 'object' &&
    ref.capabilities !== null
  );
}

function toSink(ref: Exclude<PluginRef, string>): SinkV1 {
  if (!isSinkShape(ref)) {
    throw new VetError(
      CEV_ERROR_CODES.E_ADAPTER_CAPABILITY,
      `sink "${ref.id}" is not a SinkV1: it needs a doWrite function and capabilities`,
    );
  }
  // Checks specVersion and that capabilities.batch is a positive integer.
  return defineSink(ref);
}

// OTEL_EXPORTER_OTLP_HEADERS syntax (W3C Baggage, no metadata): comma-separated k=v pairs.
// Each pair splits on the FIRST '=' only (base64 tokens end in '='), key and value are
// trimmed, empty entries are skipped, and the value is percent-decoded. Never echoes the
// pair or the key on failure — only the *Env variable name is named.
function parseOtlpHeaders(raw: string, envName: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const invalid = (): VetError =>
    configInvalid(`Environment variable ${envName} is not valid OTLP header syntax`);
  for (const entry of raw.split(',')) {
    if (entry.trim() === '') continue;
    const eq = entry.indexOf('=');
    if (eq === -1) throw invalid();
    const key = entry.slice(0, eq).trim();
    const rawValue = entry.slice(eq + 1).trim();
    if (key === '') throw invalid();
    try {
      headers[key] = decodeURIComponent(rawValue);
    } catch (error) {
      if (error instanceof URIError) throw invalid();
      throw error;
    }
  }
  return headers;
}

function buildOtelSink(
  descriptor: Extract<SinkDescriptor, { kind: 'otel' }>,
  env: Readonly<Record<string, string | undefined>>,
  fetchImpl: typeof fetch | undefined,
): SinkV1 {
  const headers =
    descriptor.headersEnv === undefined
      ? undefined
      : parseOtlpHeaders(readEnvName(descriptor.headersEnv, env), descriptor.headersEnv);
  try {
    return createOtelSink({
      endpoint: descriptor.endpoint,
      ...(headers === undefined ? {} : { headers }),
      ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
    });
  } catch (error) {
    if (error instanceof TypeError) throw configInvalid(`sink 'otel': endpoint is not a valid URL`);
    throw error;
  }
}

function buildLangfuseSink(
  descriptor: Extract<SinkDescriptor, { kind: 'langfuse' }>,
  env: Readonly<Record<string, string | undefined>>,
  fetchImpl: typeof fetch | undefined,
): SinkV1 {
  const baseUrl = readEnvName(descriptor.baseUrlEnv, env);
  if (!URL.canParse(baseUrl)) {
    throw configInvalid(`Environment variable ${descriptor.baseUrlEnv} is not a valid URL`);
  }
  const publicKey = readEnvName(descriptor.publicKeyEnv, env);
  const secretKey = readEnvName(descriptor.secretKeyEnv, env);
  return createLangfuseSink({
    baseUrl,
    publicKey,
    secretKey,
    ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
  });
}

function buildDescriptorSink(
  descriptor: SinkDescriptor & { readonly kind: SinkDescriptorKind },
  env: Readonly<Record<string, string | undefined>>,
  fetchImpl: typeof fetch | undefined,
): SinkV1 {
  return descriptor.kind === 'otel'
    ? buildOtelSink(descriptor, env, fetchImpl)
    : buildLangfuseSink(descriptor, env, fetchImpl);
}

export function resolveSinks(
  config: SinkConfig,
  names: readonly string[],
  options: {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly fetch?: typeof fetch;
  } = {},
): ResolvedSink[] {
  const env = options.env ?? process.env;
  const configured = configuredSinkNames(config);
  const out: ResolvedSink[] = [];
  for (const name of new Set(names)) {
    const exact = config.sinks.filter((ref) => sinkRefName(ref) === name);
    const matches =
      exact.length > 0
        ? exact
        : config.sinks.filter((ref) => sinkRefName(ref).split('/')[0] === name);
    const [ref] = matches;
    if (ref === undefined) throw unknownSink(`unknown sink '${name}'`, configured);
    if (matches.length > 1) {
      const candidates = matches.map(sinkRefName).join(', ');
      throw unknownSink(`sink '${name}' is ambiguous: matches ${candidates}`, configured);
    }
    if (typeof ref === 'string') {
      throw unknownSink(
        `sink '${name}' is declared by name only; construct it in vetkit.config.ts`,
        configured,
      );
    }
    const sink = 'kind' in ref ? buildDescriptorSink(ref, env, options.fetch) : toSink(ref);
    if (!out.some((r) => r.sink === sink)) out.push({ name, sink });
  }
  return out;
}
