// `vet run`: load vetkit.config.ts, judge every case (core runEvals) and exit with its code.
// Under --json stdout carries exactly one JSON document (the runEvals result as-is); warnings
// and errors go to stderr. SIGINT aborts the run: partial results are still printed, with
// summary.aborted true, and the exit code is 130 (root DECISION C5).
import { resolve } from 'node:path';
import {
  createEvents,
  LOCK_FILE,
  readLockOrNull,
  runEvals,
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
  const cacheDir = resolve(rootDir, config.cacheDir);
  const startedAt = new Date().toISOString();
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
      events,
    });
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
