import { CommanderError } from 'commander';
import { VetError } from '@vetkit/spec';
import { redact } from './redact.ts';

// Exit codes are local to the CLI until the app-shell leaf (classified-evals-mol-uu0)
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
// User-input and credential codes (docs/contracts/j1.md "Exit codes": 2 = config
// error), matched after E_ stripping.
const INPUT_EXIT_CODES = new Set([
  'CRITERIA_INVALID',
  'CASE_INVALID',
  'INPUT_TOO_LARGE',
  'LABELS_INVALID',
  'LABELS_TOO_FEW',
  'JUDGE_UNAUTHORIZED',
  'OUTBOX_CORRUPT',
  // J5 (docs/contracts/j5.md "Error codes"): exact entries so SOURCE_EMPTY exits 2 rather than
  // falling through to the SOURCE_* warning rule below, and OTLP_PARSE exits 2 rather than 70.
  'SOURCE_EMPTY',
  'OTLP_PARSE',
]);

const HINTS: Readonly<Record<Category, string>> = {
  config: 'check your configuration and CLI flags, then retry.',
  unscored: 'no scored cases matched; add scored evals or relax the filter.',
  sinkSource: 'a sink or source adapter failed; rerun with --strict to treat this as fatal.',
  failed: 'the lock is stale; rerun vet validate to refresh it.',
  internal: 'this looks like an internal error; rerun with --verbose and file an issue.',
};

function resolveExit(code: string, strict: boolean): Resolved {
  if (CONFIG_EXIT_CODES.has(code)) return { category: 'config', exitCode: EXIT_USAGE, warn: false };
  if (INTERNAL_EXIT_CODES.has(code)) {
    return { category: 'internal', exitCode: EXIT_INTERNAL, warn: false };
  }
  const unprefixed = code.startsWith('E_') ? code.slice(2) : code;
  if (INPUT_EXIT_CODES.has(unprefixed)) {
    return { category: 'config', exitCode: EXIT_USAGE, warn: false };
  }
  // Root exit-code DECISION: a stale lock exits 1 (a missing one exits 2).
  if (unprefixed === 'LOCK_STALE') {
    return { category: 'failed', exitCode: EXIT_FAILED, warn: false };
  }
  if (
    unprefixed === 'NOT_INTERACTIVE' ||
    unprefixed.startsWith('CONFIG') ||
    unprefixed.startsWith('GATE_')
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

// Additive escape hatch (root ledger contract 76a.7 #2): forces the exit code (and
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
  const hint = HINTS[resolved.category];
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
    writeJson(ctx.stdout, 'INTERNAL', message, HINTS.internal, cause);
    return;
  }
  writePretty(ctx.stderr, 'error', 'INTERNAL', message, HINTS.internal, cause, ctx.verbose, stack);
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
