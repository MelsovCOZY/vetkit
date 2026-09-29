// `otlp:` source wiring for `vet init --source`. Registers
// the `otlp` prefix on the same seam source-jsonl uses (sources.ts): `otlp:<path>` is
// file-backed (a file or a directory of files, source-otlp's own otlpSource semantics);
// `otlp::<port>` / `otlp::0` starts an OTLP/HTTP receiver (source-otlp's startReceiver) and
// stops on --until N traces, --seconds S, or an aborted signal, whichever comes first;
// `otlp:http://…` is rejected (CONFIG_INVALID) — a remote collector push is exactly what the
// receiver is for, not a client the CLI dials out to. Cross-request traceId dedupe for the
// receiver lives here, not in startReceiver itself.
import { readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { GenerateEvalsResult } from '@vetkit/core';
import { otlpSource, startReceiver, type OtlpDiag } from '@vetkit/source-otlp';
import {
  CEV_ERROR_CODES,
  VetError,
  defineSource,
  type NormalizedTrace,
  type SourceV1,
} from '@vetkit/spec';
import { EXIT_USAGE, withExitCode } from '../errors.ts';
import { diagEnabled } from '../diag.ts';
import { getLogger } from '../output.ts';
import { registerSourcePrefix, type SourceOptions } from '../sources.ts';

const OTLP_PREFIX = 'otlp';

function unreadable(rest: string): VetError {
  return withExitCode(
    new VetError(
      CEV_ERROR_CODES.SOURCE_UNREADABLE,
      `'${rest}' is not a readable file or directory`,
    ),
    EXIT_USAGE,
  );
}

function filesInDir(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && (extname(e.name) === '.json' || extname(e.name) === '.jsonl'))
    .map((e) => join(dir, e.name))
    .toSorted();
}

// Source diagnostics go to stderr as one JSON line each, only under CEV_DIAG (or its alias);
// stdout (the --json document) is never touched.
function writeSourceDiag(d: OtlpDiag): void {
  if (!diagEnabled(process.env)) return;
  process.stderr.write(`${JSON.stringify({ diag: { otlp: d } })}\n`);
}

function fileBackedSource(rest: string): SourceV1 {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(rest);
  } catch {
    throw unreadable(rest);
  }
  const files = stat.isDirectory() ? filesInDir(rest) : [rest];
  return otlpSource({ files, onDiag: writeSourceDiag });
}

// Resolves once activity happens: a trace queued (`wake`), `signal` aborted, or `pollMs`
// elapses (a coarse recheck for --seconds' deadline). Always clears its own listener/timer.
function waitForActivity(
  signal: AbortSignal | undefined,
  pollMs: number,
  setWake: (fn: () => void) => void,
): Promise<void> {
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', finish);
      clearTimeout(timer);
      resolvePromise();
    };
    setWake(finish);
    signal?.addEventListener('abort', finish, { once: true });
    const timer = setTimeout(finish, pollMs);
    timer.unref?.();
  });
}

const POLL_MS = 100;

function receiverSource(port: number, options: SourceOptions): SourceV1 {
  async function* doRead(opts: { signal?: AbortSignal }): AsyncGenerator<NormalizedTrace> {
    const seen = new Set<string>();
    const queue: NormalizedTrace[] = [];
    let wake: (() => void) | undefined;
    const receiver = await startReceiver({
      port,
      host: '127.0.0.1',
      onRequest: (trace) => {
        if (seen.has(trace.traceId)) return;
        seen.add(trace.traceId);
        queue.push(trace);
        wake?.();
      },
    });
    getLogger().info(JSON.stringify({ listening: { port: receiver.port } }));
    const deadline =
      options.seconds === undefined ? undefined : Date.now() + options.seconds * 1000;
    try {
      let yielded = 0;
      for (;;) {
        if (queue.length > 0) {
          // oxlint-disable-next-line typescript/no-non-null-assertion
          yield queue.shift()!;
          yielded += 1;
          if (options.until !== undefined && yielded >= options.until) return;
          continue;
        }
        if (opts.signal?.aborted === true) return;
        if (deadline !== undefined && Date.now() >= deadline) return;
        const pollMs =
          deadline === undefined ? POLL_MS : Math.max(1, Math.min(POLL_MS, deadline - Date.now()));
        await waitForActivity(opts.signal, pollMs, (fn) => {
          wake = fn;
        });
      }
    } finally {
      await receiver.close();
    }
  }

  return defineSource({
    specVersion: 'v1',
    id: 'otlp/receiver',
    capabilities: { streaming: true, content: 'maybe' },
    doRead,
  });
}

const REMOTE_FORM = /^https?:\/\//i;

/** Resolves an `otlp:` source spec's `rest` (the part after `otlp:`) to a SourceV1: a file or
 * directory path (file-backed), `:<port>` (the receiver, `:0` for an ephemeral port), or a
 * rejected `http://…` remote form. `options` carries `vet init`'s --until/--seconds. */
export function otlpSourceFromArg(rest: string, options: SourceOptions = {}): SourceV1 {
  if (REMOTE_FORM.test(rest)) {
    throw new VetError(
      CEV_ERROR_CODES.CONFIG_INVALID,
      `--source 'otlp:${rest}': a remote OTLP endpoint is not supported; use otlp:<path> or otlp::<port>`,
    );
  }
  if (rest.startsWith(':')) {
    const portText = rest.slice(1);
    const port = Number(portText);
    if (!Number.isInteger(port) || port < 0) {
      throw new VetError(
        CEV_ERROR_CODES.CONFIG_INVALID,
        `--source 'otlp:${rest}': '${portText}' is not a valid port`,
      );
    }
    return receiverSource(port, options);
  }
  return fileBackedSource(rest);
}

export interface OtlpSummary {
  readonly cases: number;
  readonly excluded: Record<string, number>;
  readonly dialects: Record<string, number>;
  readonly tokens: number;
}

/** Builds the `otlp:` run summary ({cases, excluded, dialects, tokens}) from the traces read
 * (for their per-trace dialect and token counts) and the generateEvals result they produced
 * (for the case count and why any trace was excluded). */
export function buildOtlpSummary(
  traces: readonly NormalizedTrace[],
  result: GenerateEvalsResult,
): OtlpSummary {
  const excluded: Record<string, number> = {};
  for (const t of result.report.traces) {
    if (t.status === 'not_applicable') excluded[t.reason] = (excluded[t.reason] ?? 0) + 1;
  }
  const dialects: Record<string, number> = {};
  let tokens = 0;
  for (const trace of traces) {
    dialects[trace.dialect] = (dialects[trace.dialect] ?? 0) + 1;
    tokens += trace.tokens?.total ?? 0;
  }
  return { cases: result.cases.length, excluded, dialects, tokens };
}

// Called once from program.ts, alongside every other register* module. A bare side-effecting
// `import './init-otlp.ts'` (with no binding used) is dropped by tsdown/esbuild's dead-code
// elimination in this per-file build (dist/commands/init-otlp.js never got emitted for it), so
// program.ts imports and calls this explicitly instead.
export function registerOtlpSource(): void {
  registerSourcePrefix(OTLP_PREFIX, otlpSourceFromArg);
}
