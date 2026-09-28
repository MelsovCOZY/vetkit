// Sink resolution for `vet run --sink <names>` (mol-yxn.7). Sinks are adapter objects built in
// vetkit.config.ts (option A); a bare string ref has no loader yet, so naming one is refused.
// A name matches a ref by exact id, else by the id's prefix before '/' when exactly one ref has
// that prefix ('otel' -> 'otel/logs'). handleError's JSON drops details, so every message
// names the sink and the configured names itself.
import type { ResolvedConfig } from '@vetkit/core';
import { CEV_ERROR_CODES, defineSink, VetError, type PluginRef, type SinkV1 } from '@vetkit/spec';

export interface ResolvedSink {
  /** The name as given on the command line; keys the per-sink counts. */
  readonly name: string;
  readonly sink: SinkV1;
}

type SinkConfig = Pick<ResolvedConfig, 'sinks'>;

function refId(ref: PluginRef): string {
  return typeof ref === 'string' ? ref : ref.id;
}

export function configuredSinkNames(config: SinkConfig): string[] {
  return config.sinks.map(refId);
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

export function resolveSinks(config: SinkConfig, names: readonly string[]): ResolvedSink[] {
  const configured = configuredSinkNames(config);
  const out: ResolvedSink[] = [];
  for (const name of new Set(names)) {
    const exact = config.sinks.filter((ref) => refId(ref) === name);
    const matches =
      exact.length > 0 ? exact : config.sinks.filter((ref) => refId(ref).split('/')[0] === name);
    const [ref] = matches;
    if (ref === undefined) throw unknownSink(`unknown sink '${name}'`, configured);
    if (matches.length > 1) {
      const candidates = matches.map(refId).join(', ');
      throw unknownSink(`sink '${name}' is ambiguous: matches ${candidates}`, configured);
    }
    if (typeof ref === 'string') {
      throw unknownSink(
        `sink '${name}' is declared by name only; construct it in vetkit.config.ts`,
        configured,
      );
    }
    const sink = toSink(ref);
    if (!out.some((r) => r.sink === sink)) out.push({ name, sink });
  }
  return out;
}
