// `vet run`: load vetkit.config.ts, judge every case (core runEvals) and exit with its code.
// Under --json stdout carries exactly one JSON document (the runEvals result as-is); warnings
// and errors go to stderr. SIGINT aborts the run: partial results are still printed, with
// summary.aborted true, and the exit code is 130 (root DECISION C5).
import { join, resolve } from 'node:path';
import {
  createEvents,
  loadCases,
  LOCK_FILE,
  readLockOrNull,
  runEvals,
  type EventMap,
  type Events,
  type ResolvedConfig,
  type RunEvalsResult,
  type RunVerdict,
  writeRunRecord,
} from '@vetkit/core';
import type { Command } from 'commander';
import { loadVetConfig } from '../config-load.ts';
import { CEV_EXIT, emit, getLogger, type GlobalOptions } from '../output.ts';
import { renderEvents } from '../render-events.ts';
import { registerReporterFlag, writeReports, type ReporterSpec } from '../reporters/junit.ts';

interface RunOptions extends GlobalOptions {
  readonly config?: string;
  readonly criteria?: string;
  readonly cases?: string;
  readonly gate?: boolean;
  readonly ci?: boolean;
  readonly allowUnpinned?: boolean;
  readonly reporter?: ReporterSpec;
}

// Hooks other commands' modules add to `vet run` (mol-yxn.7: `--sink`). A hook runs after the
// config loads and before any judge call, so it can fail fast; the finish it returns runs on
// the result (partial on SIGINT). Only `json` is merged into the --json document; `lines` are
// appended to the pretty rendering. The exit code stays the run's.
export interface RunHookContext {
  readonly options: GlobalOptions & Readonly<Record<string, unknown>>;
  readonly config: ResolvedConfig;
  readonly rootDir: string;
}
export interface RunHookOutput {
  readonly json: Record<string, unknown>;
  readonly lines?: readonly string[];
}
export type RunHookFinish = (result: RunEvalsResult) => Promise<RunHookOutput>;
export type RunHook = (ctx: RunHookContext) => Promise<RunHookFinish | undefined>;
export const runHooks: RunHook[] = [];

type Outcome = 'pass' | 'fail' | 'unscored';

// Same precedence as the core summary: any failed verdict fails the case, then any unscored.
function caseOutcome(verdicts: readonly RunVerdict[]): Outcome {
  const counted = verdicts.filter((v) => v.status !== 'not_applicable');
  if (counted.some((v) => v.status === 'ok' && v.pass !== true)) return 'fail';
  if (counted.some((v) => v.status !== 'ok')) return 'unscored';
  return 'pass';
}

// Bug F3/F4 (gate 7lg AC1): core's exit mapping treats a judge failure (unscored) the same as
// a scored fail, so `--sink` — whose whole point is durably recording an unscored verdict for
// later drain, not blocking CI on a transient judge outage — still exited 1. With --sink set,
// an exit of 1 caused only by unscored verdicts (no real scored failure) is downgraded to 0;
// a genuine scored failure still exits 1, and without --sink nothing here changes.
function hasScoredFailure(verdicts: readonly RunVerdict[]): boolean {
  return verdicts.some((v) => v.gated !== false && v.status === 'ok' && v.pass !== true);
}

// mol-yxn.21: core emits `run:end` (which the pretty "run done" line and NDJSON render)
// the instant it decides exitCode, one tick before the --sink override above can downgrade
// it. Buffering that one event here and re-emitting the corrected payload once the override
// is decided (still before renderEvents unsubscribes) keeps every renderer in sync with the
// process exit code; every other event still passes straight through, live.
function deferRunEnd(events: Events): {
  readonly events: Events;
  readonly take: () => EventMap['run:end'] | undefined;
} {
  let pending: EventMap['run:end'] | undefined;
  // A real generic function (not an inferred object-literal property) so the forwarding call
  // below keeps `name`/`payload` correlated by K; only the run:end branch narrows unsoundly,
  // since TS can't prove that from `name === 'run:end'` alone.
  function emitOrBuffer<K extends keyof EventMap>(name: K, payload: EventMap[K]): void {
    if (name === 'run:end') {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      pending = payload as EventMap['run:end'];
      return;
    }
    events.emit(name, payload);
  }
  const proxy: Events = {
    on: (name, listener) => events.on(name, listener),
    once: (name, listener) => events.once(name, listener),
    off: (name, listener) => {
      events.off(name, listener);
    },
    diag: (level, code, message, data) => {
      events.diag(level, code, message, data);
    },
    emit: emitOrBuffer,
  };
  return { events: proxy, take: () => pending };
}

function render(result: RunEvalsResult): string {
  const byCase = new Map<string, RunVerdict[]>();
  for (const v of result.results) byCase.set(v.caseId, [...(byCase.get(v.caseId) ?? []), v]);
  const lines = [...byCase].map(([caseId, verdicts]) => `${caseOutcome(verdicts)} ${caseId}`);
  const { summary, model } = result;
  lines.push(
    `${String(summary.passed)} passed, ${String(summary.failed)} failed, ${String(summary.unscored)} unscored of ${String(summary.total)}${summary.aborted ? ' (aborted)' : ''}`,
    `model: ${model.resolved === '' ? model.requested : model.resolved} (transport ${model.transport}, pinned: ${String(model.pinned)})`,
  );
  return lines.join('\n');
}

// evals/cases/pending/ is where promote.ts (dh8.3) writes auto-promoted cases; the J1
// loader's default evals/cases/*.jsonl glob never recurses into it (docs/contracts/j7.md
// "Promotion"), so a case sitting there is otherwise invisible until `vet cases review`
// (mol-p4a.1) moves it up a level. A missing pending/ directory (the common case before any
// promotion has happened) counts as 0, not an error.
async function countPendingCases(casesPath: string): Promise<number> {
  const result = await loadCases(join(casesPath, 'pending'));
  return result.ok ? result.cases.length : 0;
}

async function runCommand(options: RunOptions & Readonly<Record<string, unknown>>): Promise<void> {
  const log = getLogger();
  const cwd = process.cwd();
  const loaded = await loadVetConfig({
    cwd,
    ...(options.config === undefined ? {} : { configPath: options.config }),
  });
  for (const warning of loaded.warnings) log.warn(warning);
  const { config, rootDir } = loaded;
  // Missing lock → null (the gate then refuses); an invalid one throws (exit 2). q4q.11.
  const lock = await readLockOrNull(resolve(rootDir, LOCK_FILE));
  const finishes: RunHookFinish[] = [];
  for (const hook of runHooks) {
    const finish = await hook({ options, config, rootDir });
    if (finish !== undefined) finishes.push(finish);
  }

  const controller = new AbortController();
  const onSigint = (): void => {
    // A second Ctrl-C does not wait for in-flight requests to settle.
    if (controller.signal.aborted) process.exit(CEV_EXIT.SIGINT);
    controller.abort();
  };
  process.on('SIGINT', onSigint);
  // Progress renders on stderr (render-events.ts); stdout stays the result document.
  const events = createEvents();
  const stopRendering = renderEvents(events, { options });
  const criteriaPath = resolve(options.criteria ?? resolve(rootDir, 'evals/criteria.yaml'));
  const casesPath = resolve(options.cases ?? resolve(rootDir, 'evals/cases'));
  const pendingCount = await countPendingCases(casesPath);
  log.info(
    `${String(pendingCount)} promoted case(s) pending review in ${join(casesPath, 'pending')} (run \`vet cases review\`)`,
  );
  const cacheDir = resolve(rootDir, config.cacheDir);
  const startedAt = new Date().toISOString();
  const { events: runEvalsEvents, take: takeRunEnd } = deferRunEnd(events);
  let result: RunEvalsResult;
  try {
    result = await runEvals({
      config: {
        criteriaPath,
        casesDir: casesPath,
        judge: loaded.judge,
        threshold: config.thresholds.default,
        gate: options.gate === true,
        ci: options.ci === true,
        gatePolicy: {
          ...config.gate,
          allowUnpinned: options.allowUnpinned === true || config.gate.allowUnpinned,
        },
        cacheDir,
      },
      lock,
      signal: controller.signal,
      events: runEvalsEvents,
    });

    // --sink AC1: an exit of 1 from unscored verdicts alone never blocks a --sink run.
    if (
      options['sink'] !== undefined &&
      result.exitCode === 1 &&
      !hasScoredFailure(result.results)
    ) {
      result.exitCode = 0;
    }

    // Re-emit the buffered run:end (if any) with the now-final exitCode, while renderEvents
    // is still subscribed, so the pretty/NDJSON line matches the process exit code.
    const pendingRunEnd = takeRunEnd();
    if (pendingRunEnd !== undefined) {
      events.emit('run:end', { ...pendingRunEnd, exitCode: result.exitCode });
    }
  } finally {
    stopRendering();
    process.off('SIGINT', onSigint);
  }

  for (const reason of result.gateReasons) log.error(`gate refused: ${reason}`);
  await writeReports(options.reporter, [{ criteriaPath, result }], { cwd });
  const extras: Record<string, unknown> = {};
  const lines: string[] = [];
  for (const finish of finishes) {
    const out = await finish(result);
    Object.assign(extras, out.json);
    lines.push(...(out.lines ?? []));
  }
  // The record is the --json document plus its inputs (mol-p4a.16); partial runs included.
  await writeRunRecord(cacheDir, { ...result, ...extras, criteriaPath, casesPath, startedAt });
  emit({ ...result, ...extras }, () => [render(result), ...lines].join('\n'));
  process.exitCode = result.exitCode;
}

export function registerRun(program: Command): Command {
  return registerReporterFlag(
    program
      .command('run')
      .description('judge every case against the criteria and exit with the result')
      .option('--config <path>', 'config file (default: vetkit.config.* in the current directory)')
      .option(
        '--criteria <file>',
        'criteria file (default: evals/criteria.yaml next to the config)',
      )
      .option('--cases <dir>', 'cases directory (default: evals/cases next to the config)')
      .option('--gate', 'gate on calibrated thresholds from the lock; refuses (exit 2) without one')
      .option('--ci', 'CI gating: refuse (exit 2) a lock written against an unpinned transport')
      .option('--allow-unpinned', 'let --gate and --ci pass on an unpinned judge transport'),
  ).action(async (_options: unknown, command: Command) => {
    await runCommand(command.optsWithGlobals<RunOptions & Readonly<Record<string, unknown>>>());
  });
}
