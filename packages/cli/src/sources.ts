// Source string resolution for `vet init --source <path>`. A bare path or
// `jsonl:<dir>` both resolve to a filesystem-backed source-jsonl SourceV1. Other prefixes
// register through registerSourcePrefix (J5 `otlp:`, J6 `langfuse:`) without touching this
// module's callers. A prefix that wants a pre-flight check on `rest` (jsonl's own stat +
// isDirectory) passes a `validate` hook to registerSourcePrefix;
// resolveSource runs only the matched prefix's own hook, so `otlp::4318` (rest ':4318', not a
// directory at all) reaches otlp's factory unchecked while jsonl keeps its exit 2
// SOURCE_UNREADABLE behaviour unchanged. `options` (until/seconds) is forwarded from
// `vet init`'s flags straight through to the matched factory; jsonl's factory ignores it.
import { statSync } from 'node:fs';
import { createJsonlSource } from '@vetkit/source-jsonl';
import { CEV_ERROR_CODES, VetError, type SourceV1 } from '@vetkit/spec';
import { EXIT_USAGE, withExitCode } from './errors.ts';

export interface SourceOptions {
  readonly until?: number;
  readonly seconds?: number;
}

export type SourceFactory = (rest: string, options?: SourceOptions) => SourceV1;
export type SourceValidate = (rest: string) => void;

interface PrefixEntry {
  readonly factory: SourceFactory;
  readonly validate?: SourceValidate;
}

const DEFAULT_PREFIX = 'jsonl';
const prefixes = new Map<string, PrefixEntry>();

/** Registers a new `<prefix>:<rest>` source string; later calls win over earlier ones. An
 * omitted `validate` means resolveSource passes `rest` straight to `factory`, unchecked. */
export function registerSourcePrefix(
  prefix: string,
  factory: SourceFactory,
  validate?: SourceValidate,
): void {
  prefixes.set(prefix, validate === undefined ? { factory } : { factory, validate });
}

function unreadable(rest: string): VetError {
  return withExitCode(
    new VetError(CEV_ERROR_CODES.SOURCE_UNREADABLE, `'${rest}' is not a readable directory`),
    EXIT_USAGE,
  );
}

function jsonlValidate(rest: string): void {
  let info: ReturnType<typeof statSync>;
  try {
    info = statSync(rest);
  } catch {
    throw unreadable(rest);
  }
  if (!info.isDirectory()) throw unreadable(rest);
}

registerSourcePrefix(DEFAULT_PREFIX, (dir) => createJsonlSource({ dir }), jsonlValidate);

interface SplitSpec {
  readonly prefix: string;
  readonly rest: string;
}

function splitSpec(spec: string): SplitSpec {
  const colon = spec.indexOf(':');
  if (colon === -1) return { prefix: DEFAULT_PREFIX, rest: spec };
  return { prefix: spec.slice(0, colon), rest: spec.slice(colon + 1) };
}

/** Resolves a `--source` string to a SourceV1; throws VetError (SOURCE_UNREADABLE, exit 2) from
 * the matched prefix's own validate hook, or CONFIG_INVALID on an unregistered prefix. */
export function resolveSource(spec: string, options?: SourceOptions): SourceV1 {
  const { prefix, rest } = splitSpec(spec);
  const entry = prefixes.get(prefix);
  if (entry === undefined) {
    throw new VetError(
      CEV_ERROR_CODES.CONFIG_INVALID,
      `--source '${spec}': unknown source prefix '${prefix}'; registered: ${[...prefixes.keys()].join(', ')}`,
    );
  }
  entry.validate?.(rest);
  return entry.factory(rest, options);
}
