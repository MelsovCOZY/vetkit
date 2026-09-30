import { CommanderError } from 'commander';
import { VetError } from '@vetkit/spec';
import { redact } from './redact.ts';

// Exit codes are local to the CLI until the app-shell leaf
// centralizes them. EX_SOFTWARE (70) is the BSD sysexits fallback for "internal error".
export const EXIT_OK = 0;
export const EXIT_USAGE = 2;
export const EXIT_UNSCORED_ONLY = 3;
export const EXIT_SINK_SOURCE_STRICT = 1;
export const EXIT_FAILED = 1;
export const EXIT_SIGINT = 130;
export const EXIT_INTERNAL = 70;

// Structural stand-in for NodeJS.WritableStream so this public declaration doesn't
// depend on @types/node ambient globals (consumers without @types/node get TS2503).
interface WritableLike {
  write(chunk: string): unknown;
}

export interface HandleErrorContext {
  readonly json: boolean;
  readonly verbose: boolean;
  readonly strict: boolean;
  readonly stdout: WritableLike;
  readonly stderr: WritableLike;
  readonly exit: (code: number) => never;
}

type Category = 'config' | 'unscored' | 'sinkSource' | 'failed' | 'internal';

interface Resolved {
  readonly category: Category;
  readonly exitCode: number;
  readonly warn: boolean;
}

// Existing @vetkit/spec codes (packages/spec/src/errors.ts), folded into this table
// so exact entries win before the prefix rules below run.
const CONFIG_EXIT_CODES = new Set([
  'E_CONFIG',
  'E_ADAPTER_SPEC_VERSION',
  'E_ADAPTER_CAPABILITY',
  'E_SCHEMA_INVALID',
  'E_JSON_PARSE',
  'E_AUTH',
  'E_UNPINNED_LOCK',
  'E_UNCALIBRATED',
]);
const INTERNAL_EXIT_CODES = new Set(['E_IO', 'E_NETWORK', 'E_TIMEOUT', 'E_RATE_LIMIT']);
// User-input and credential codes (2 = config
// error), matched after E_ stripping.
const INPUT_EXIT_CODES = new Set([
  'CRITERIA_INVALID',
  'CASE_INVALID',
  'INPUT_TOO_LARGE',
  'LABELS_INVALID',
  'LABELS_TOO_FEW',
  'JUDGE_UNAUTHORIZED',
  'OUTBOX_CORRUPT',
  // Exact entries so SOURCE_EMPTY exits 2 rather than
  // falling through to the SOURCE_* warning rule below, and OTLP_PARSE exits 2 rather than 70.
  'SOURCE_EMPTY',
  'OTLP_PARSE',
  // `vet rerun` with no persisted run record (a missing input, like CASE_INVALID).
  'RUN_NOT_FOUND',
  // Exact entries so `vet watch`'s
  // RECEIVER_BIND (port already in use) and WATCH_CONFIG (--sample outside 0..1) exit 2
  // rather than falling through to the unknown-code INTERNAL (70) fallback below.
  'RECEIVER_BIND',
  'WATCH_CONFIG',
]);

const HINT_INTERNAL = 'this looks like an internal error; rerun with --verbose and file an issue.';
const HINT_SINK =
  'the sink write failed and unsent verdicts wait in the outbox; fix the sink, then run vet check --outbox, or retry with vet run --sink <names>.';
const HINT_SOURCE =
  'the trace source failed; check the source path or endpoint, then rerun vet init --source <spec>.';
const HINT_GENERATOR =
  'the generator model failed; check the generator entry in vetkit.config.ts and its credentials, then retry.';

// Per-code next-step hints, keyed by the E_-stripped code. A hint names a command as
// `vet <command>` and a flag only right after the command that owns it; global flags
// (--json, --quiet, --verbose, --no-color) may appear bare.
export const HINTS_BY_CODE: Readonly<Record<string, string>> = {
  CONFIG_INVALID:
    'run vet doctor --config to see the resolved config, fix the field named above, then retry.',
  CONFIG:
    'run vet doctor --config to see the resolved config, fix the field named above, then retry.',
  CONFIG_UNKNOWN_SINK:
    'the sink name is not under sinks in vetkit.config.ts; add it there or pick a configured one.',
  CRITERIA_INVALID: 'fix the criteria file at the line named above; run vet lint to recheck it.',
  CASE_INVALID:
    'a case file must hold one JSON object per line; fix the line named above or regenerate with vet init.',
  LABELS_INVALID:
    'a labels row is malformed; the columns are case_id,criterion_id,label,labeler,labeled_at.',
  LABELS_TOO_FEW:
    'not enough labels to calibrate; import a CSV with vet label --from <path> or label interactively with vet label --tty, then run vet validate.',
  LOCK_STALE: 'the lock is stale; rerun vet validate to refresh it.',
  GATE_UNCALIBRATED: 'no calibrated lock for this gate; run vet validate to write one, then retry.',
  UNCALIBRATED: 'no calibrated lock for this gate; run vet validate to write one, then retry.',
  GATE_UNPINNED:
    'the lock was written on an unpinned judge transport; pin the judge model, or accept it with vet run --allow-unpinned.',
  UNPINNED_LOCK:
    'the lock was written on an unpinned judge transport; pin the judge model, or accept it with vet run --allow-unpinned.',
  GATE_REFUSED: 'the gate refused this run; see the gate reasons above and fix the first one.',
  JUDGE_UNAUTHORIZED:
    'the judge rejected the credential; run vet doctor to check the key and endpoint.',
  AUTH: 'the judge rejected the credential; run vet doctor to check the key and endpoint.',
  JUDGE_UNAVAILABLE:
    'the judge endpoint is unreachable or down; run vet doctor to check it, then retry.',
  JUDGE_TIMEOUT: 'the judge timed out; run vet doctor to check the endpoint, then retry.',
  NETWORK: 'a network call failed; run vet doctor to check the endpoint, then retry.',
  TIMEOUT: 'a call timed out; run vet doctor to check the endpoint, then retry.',
  RATE_LIMIT: 'the provider is throttling requests; wait a minute, then retry.',
  JUDGE_BAD_RESPONSE:
    'the judge returned an unusable answer; rerun with --verbose and file an issue with the output.',
  INPUT_TOO_LARGE: 'an input exceeds the judge limit; shorten the case or trace, then retry.',
  UNSCORED_ONLY: 'no case could be judged; run vet doctor to check the judge, then rerun.',
  NOT_INTERACTIVE:
    'a prompt needs a terminal; pass the value as a flag or set it in vetkit.config.ts.',
  RUN_NOT_FOUND: 'there is no earlier run to reuse; run vet run first.',
  EXPORT_TARGET_UNKNOWN: 'that export target is not registered; try vet export --to vitest.',
  EXPORT_NO_LOCK:
    'there is no criteria.lock.json; run vet validate to write it, or drop vet export --require-lock.',
  RECEIVER_BIND: 'the port is taken or not allowed; pick another with vet watch --port <n>.',
  WATCH_CONFIG: 'the sample rate must be between 0 and 1; set vet watch --sample <rate>.',
  OUTBOX_CORRUPT:
    'the outbox file is corrupt; inspect it, then run vet check --outbox to reconcile.',
  TRACE_INVALID:
    'a trace could not be read; check the source data, then rerun vet init --source <spec>.',
  OTLP_PARSE:
    'the OTLP body is not a trace export request; check the sender, then rerun vet init --source <spec>.',
  OTLP_UNSUPPORTED_CONTENT_TYPE:
    'the receiver accepts OTLP JSON only; set the exporter protocol to http/json.',
  SOURCE_EMPTY:
    'the source produced 0 traces; check its path or filter, then rerun vet init --source <spec>.',
  ADAPTER_SPEC_VERSION:
    'the adapter targets another spec version; upgrade the adapter or vetkit so the spec version matches.',
  ADAPTER_CAPABILITY:
    'the adapter lacks a required capability; use an adapter that declares it, or change the config that needs it.',
  SCHEMA_INVALID: 'a value does not match its schema; fix the field at the pointer named above.',
  JSON_PARSE: 'a file is not valid JSON; fix the syntax at the pointer named above.',
  IO: 'a file operation failed; check permissions and free space for the cache directory (.vet).',
  CACHE_IO:
    'the cache could not be read or written; check permissions and space under .vet, or delete it.',
};

// Prefix classes that share one hint; tried after the exact table.
const PREFIX_HINTS: readonly (readonly [string, string])[] = [
  ['SINK_', HINT_SINK],
  ['SOURCE_', HINT_SOURCE],
  ['GENERATOR_', HINT_GENERATOR],
  ['GATE_', HINTS_BY_CODE.GATE_REFUSED ?? HINT_INTERNAL],
  ['CONFIG', HINTS_BY_CODE.CONFIG_INVALID ?? HINT_INTERNAL],
  ['EXPORT_', HINTS_BY_CODE.EXPORT_TARGET_UNKNOWN ?? HINT_INTERNAL],
];

/** The one next-step line printed under an error; unknown codes get the internal-error hint. */
export function hintFor(code: string): string {
  const key = code.startsWith('E_') ? code.slice(2) : code;
  const exact = HINTS_BY_CODE[key];
  if (exact !== undefined) return exact;
  for (const [prefix, hint] of PREFIX_HINTS) if (key.startsWith(prefix)) return hint;
  return HINT_INTERNAL;
}

function resolveExit(code: string, strict: boolean): Resolved {
  if (CONFIG_EXIT_CODES.has(code)) return { category: 'config', exitCode: EXIT_USAGE, warn: false };
  if (INTERNAL_EXIT_CODES.has(code)) {
    return { category: 'internal', exitCode: EXIT_INTERNAL, warn: false };
  }
  const unprefixed = code.startsWith('E_') ? code.slice(2) : code;
  if (INPUT_EXIT_CODES.has(unprefixed)) {
    return { category: 'config', exitCode: EXIT_USAGE, warn: false };
  }
  // A stale lock exits 1 (a missing one exits 2).
  if (unprefixed === 'LOCK_STALE') {
    return { category: 'failed', exitCode: EXIT_FAILED, warn: false };
  }
  if (
    unprefixed === 'NOT_INTERACTIVE' ||
    unprefixed.startsWith('CONFIG') ||
    unprefixed.startsWith('GATE_') ||
    // `vet export`'s EXPORT_TARGET_UNKNOWN / EXPORT_NO_LOCK.
    unprefixed.startsWith('EXPORT_')
  ) {
    return { category: 'config', exitCode: EXIT_USAGE, warn: false };
  }
  if (unprefixed === 'UNSCORED_ONLY') {
    return { category: 'unscored', exitCode: EXIT_UNSCORED_ONLY, warn: false };
  }
  if (unprefixed.startsWith('SINK_') || unprefixed.startsWith('SOURCE_')) {
    return strict
      ? { category: 'sinkSource', exitCode: EXIT_SINK_SOURCE_STRICT, warn: false }
      : { category: 'sinkSource', exitCode: EXIT_OK, warn: true };
  }
  return { category: 'internal', exitCode: EXIT_INTERNAL, warn: false };
}

// Additive escape hatch: forces the exit code (and
// error-severity rendering) for one VetError instance, bypassing resolveExit's class-based
// rules. SOURCE_UNREADABLE is lenient by class (the SOURCE_* prefix rule above) for the
// runtime degradation `run`/`run-sinks` rely on, but `vet init --source`'s one pre-flight
// stat check on a path the user named needs exit 2 without changing that class rule.
const EXIT_OVERRIDE = Symbol('vetkit.errors.exitOverride');

export function withExitCode(err: VetError, exitCode: number): VetError {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  (err as unknown as Record<symbol, unknown>)[EXIT_OVERRIDE] = exitCode;
  return err;
}

function exitOverride(err: VetError): number | undefined {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const value = (err as unknown as Record<symbol, unknown>)[EXIT_OVERRIDE];
  return typeof value === 'number' ? value : undefined;
}

function causeMessage(cause: unknown): string | undefined {
  return cause instanceof Error ? cause.message : undefined;
}

function writeJson(
  stdout: WritableLike,
  code: string,
  message: string,
  hint: string,
  cause: unknown,
): void {
  const body: Record<string, unknown> = { code, message, hint };
  const cm = causeMessage(cause);
  if (cm !== undefined) body.cause = redact(cm);
  stdout.write(`${JSON.stringify({ error: body })}\n`);
}

function writeCauseChain(stderr: WritableLike, cause: unknown): void {
  let current = cause;
  while (current instanceof Error) {
    stderr.write(`  caused by: ${current.message}\n`);
    current = current.cause;
  }
}

function writePretty(
  stderr: WritableLike,
  label: 'error' | 'warning',
  code: string,
  message: string,
  hint: string,
  cause: unknown,
  verbose: boolean,
  stack?: string,
): void {
  stderr.write(`${label} ${code}: ${message}\n`);
  stderr.write(`${hint}\n`);
  if (!verbose) return;
  writeCauseChain(stderr, cause);
  if (stack !== undefined) stderr.write(`${stack}\n`);
}

function renderResolved(err: VetError, resolved: Resolved, ctx: HandleErrorContext): void {
  const hint = hintFor(err.code);
  if (ctx.json) {
    writeJson(ctx.stdout, err.code, err.message, hint, err.cause);
    return;
  }
  writePretty(
    ctx.stderr,
    resolved.warn ? 'warning' : 'error',
    err.code,
    err.message,
    hint,
    err.cause,
    ctx.verbose,
  );
}

function renderUnknown(err: unknown, ctx: HandleErrorContext): void {
  const message = err instanceof Error ? err.message : 'unknown error';
  const cause = err instanceof Error ? err.cause : undefined;
  const stack = ctx.verbose && err instanceof Error ? err.stack : undefined;
  if (ctx.json) {
    writeJson(ctx.stdout, 'INTERNAL', message, HINT_INTERNAL, cause);
    return;
  }
  writePretty(ctx.stderr, 'error', 'INTERNAL', message, HINT_INTERNAL, cause, ctx.verbose, stack);
}

export function handleError(err: unknown, ctx: HandleErrorContext): never {
  // ctx.exit is called exactly once, after this block, so a test double that throws
  // to unwind (rather than truly never returning, like process.exit) can't be mistaken
  // for a rendering failure and caught below.
  let exitCode: number;
  try {
    if (err instanceof CommanderError) {
      exitCode = EXIT_USAGE;
    } else if (err instanceof Error && err.name === 'AbortError') {
      exitCode = EXIT_SIGINT;
    } else if (VetError.isInstance(err)) {
      const override = exitOverride(err);
      const resolved =
        override === undefined
          ? resolveExit(err.code, ctx.strict)
          : { category: 'config' as const, exitCode: override, warn: false };
      renderResolved(err, resolved, ctx);
      exitCode = resolved.exitCode;
    } else {
      renderUnknown(err, ctx);
      exitCode = EXIT_INTERNAL;
    }
  } catch {
    ctx.stderr.write('error INTERNAL: failed to render error\n');
    exitCode = EXIT_INTERNAL;
  }
  return ctx.exit(exitCode);
}
