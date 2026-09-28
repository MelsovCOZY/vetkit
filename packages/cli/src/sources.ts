// Source string resolution for `vet init --source <path>` (bead mol-76a.7). A bare path or
// `jsonl:<dir>` both resolve to a filesystem-backed source-jsonl SourceV1. Other prefixes
// register through registerSourcePrefix (J5 `otlp:`, J6 `langfuse:`) without touching this
// module's callers. Before constructing, the resolved path is stat-checked here so a path
// the user named surfaces as exit 2 SOURCE_UNREADABLE (withExitCode), independent of
// source-jsonl's own lenient runtime diagnostics (onDiag), which stay warn-only for the
// `run`/`run-sinks` SOURCE_* class rule.
import { statSync } from 'node:fs';
import { createJsonlSource } from '@vetkit/source-jsonl';
import { CEV_ERROR_CODES, VetError, type SourceV1 } from '@vetkit/spec';
import { EXIT_USAGE, withExitCode } from './errors.ts';

export type SourceFactory = (spec: string) => SourceV1;

const DEFAULT_PREFIX = 'jsonl';
const prefixes = new Map<string, SourceFactory>();

/** Registers a new `<prefix>:<rest>` source string; later calls win over earlier ones. */
export function registerSourcePrefix(prefix: string, factory: SourceFactory): void {
  prefixes.set(prefix, factory);
}

registerSourcePrefix(DEFAULT_PREFIX, (dir) => createJsonlSource({ dir }));

interface SplitSpec {
  readonly prefix: string;
  readonly rest: string;
}

function splitSpec(spec: string): SplitSpec {
  const colon = spec.indexOf(':');
  if (colon === -1) return { prefix: DEFAULT_PREFIX, rest: spec };
  return { prefix: spec.slice(0, colon), rest: spec.slice(colon + 1) };
}

function unreadable(spec: string, rest: string): VetError {
  return withExitCode(
    new VetError(
      CEV_ERROR_CODES.SOURCE_UNREADABLE,
      `--source '${spec}': ${rest} is not a readable directory`,
    ),
    EXIT_USAGE,
  );
}

/** Resolves a `--source` string to a SourceV1; throws VetError (SOURCE_UNREADABLE, exit 2) on
 * a path that does not stat as a directory, or CONFIG_INVALID on an unregistered prefix. */
export function resolveSource(spec: string): SourceV1 {
  const { prefix, rest } = splitSpec(spec);
  const factory = prefixes.get(prefix);
  if (factory === undefined) {
    throw new VetError(
      CEV_ERROR_CODES.CONFIG_INVALID,
      `--source '${spec}': unknown source prefix '${prefix}'; registered: ${[...prefixes.keys()].join(', ')}`,
    );
  }
  let info: ReturnType<typeof statSync>;
  try {
    info = statSync(rest);
  } catch {
    throw unreadable(spec, rest);
  }
  if (!info.isDirectory()) throw unreadable(spec, rest);
  return factory(rest);
}
