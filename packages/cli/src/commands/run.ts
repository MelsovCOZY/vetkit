// `vet run`: load vetkit.config.ts, judge every case (core runEvals) and exit with its code.
// Under --json stdout carries exactly one JSON document (the runEvals result as-is); warnings
// and errors go to stderr. SIGINT aborts the run: partial results are still printed, with
// summary.aborted true, and the exit code is 130.
import { join, relative, resolve, sep } from 'node:path';
import {
  createEvents,
  loadCases,
  LOCK_FILE,
  readLockOrNull,
  readRunRecord,
  runEvals,
  type EventMap,
  type Events,
  type ResolvedConfig,
  type RunEvalsResult,
  type RunVerdict,
  writeRunRecord,
} from '@vetkit/core';
import { CEV_ERROR_CODES, VetError, type JudgeV1 } from '@vetkit/spec';
import { JEV_CREDENTIAL_PRIORITY, JEV_PRESETS } from '@vetkit/judge-jev';
import type { Command } from 'commander';
import { loadVetConfig } from '../config-load.ts';
import { CEV_EXIT, emit, getLogger, type GlobalOptions } from '../output.ts';
import { hintFor } from '../errors.ts';
import { isDemoJudge } from '../demo-judge.ts';
import { readCliVersion, recordingJudge, replayJudge } from '../judge-record.ts';
import { renderEvents } from '../render-events.ts';
import { writeBadge } from '../reporters/badge.ts';
import { reportToGithub } from '../reporters/github.ts';
import { renderHtml } from '../reporters/html.ts';
import {
  registerReporterFlag,
  writeReports,
  writeTextReport,
  type ReporterSpec,
} from '../reporters/junit.ts';
import {
  buildReportModel,
  loadReportInputs,
  renderMarkdown,
  VETKIT_VERSION,
} from '../reporters/report.ts';

interface RunOptions extends GlobalOptions {
  readonly config?: string;
  readonly criteria?: string;
  readonly cases?: string;
  readonly gate?: boolean;
  readonly ci?: boolean;
  readonly allowUnpinned?: boolean;
  // commander's negatable `--no-cache`: false when passed, otherwise true.
  readonly cache?: boolean;
  readonly reporter?: readonly ReporterSpec[];
  readonly includeCases?: boolean;
  readonly repeat?: string;
  readonly record?: string;
  readonly replay?: string;
}

// Hooks other commands' modules add to `vet run` (`--sink`). A hook runs after the
// config loads and before any judge call, so it can fail fast; the finish it returns runs on
// the result (partial on SIGINT). Only `json` is merged into the --json document; `lines` are
// appended to the pretty rendering. The exit code stays the run's.
export interface RunHookContext {
  readonly options: GlobalOptions & Readonly<Record<string, unknown>>;
  readonly config: ResolvedConfig;
  readonly rootDir: string;
}
interface RunHookOutput {
  readonly json: Record<string, unknown>;
  readonly lines?: readonly string[];
}
export type RunHookFinish = (result: RunEvalsResult) => Promise<RunHookOutput>;
export type RunHook = (ctx: RunHookContext) => Promise<RunHookFinish | undefined>;
export const runHooks: RunHook[] = [];

// The rolled-up state of a case comes from core's summary; a case of only not_applicable
// verdicts reads as passed, as it counts in summary.passed.
function caseWord(result: RunEvalsResult, caseId: string): string {
  const outcome = result.summary.byCase?.[caseId]?.outcome ?? 'unscored';
  if (outcome === 'flaky') {
    return `flaky ${caseId} (spread ${(result.summary.byCase?.[caseId]?.spread ?? 0).toFixed(2)})`;
  }
  return `${outcome === 'neutral' ? 'pass' : outcome} ${caseId}`;
}

function parseRepeat(raw: string | undefined): number {
  if (raw === undefined) return 1;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new VetError(
      CEV_ERROR_CODES.CONFIG_INVALID,
      `--repeat must be a positive integer, got '${raw}'`,
    );
  }
  return n;
}

// Core's exit mapping treats a judge failure (unscored) the same as
// a scored fail, so `--sink` — whose whole point is durably recording an unscored verdict for
// later drain, not blocking CI on a transient judge outage — still exited 1. With --sink set,
// an exit of 1 caused only by unscored verdicts (no real scored failure) is downgraded to 0;
// a genuine scored failure still exits 1, and without --sink nothing here changes.
function hasScoredFailure(verdicts: readonly RunVerdict[]): boolean {
  return verdicts.some((v) => v.gated !== false && v.status === 'ok' && v.pass !== true);
}

// core emits `run:end` (which the pretty "run done" line and NDJSON render)
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

// One stderr line telling a demo-judge user how to switch to a real judge. Credential names
// come from the judge-jev preset data, in priority order (same shape as init.ts's warning).
function demoHint(): string {
  const names = JEV_CREDENTIAL_PRIORITY.map((p) =>
    JEV_PRESETS[p].credentials.map((c) => c.name).join(' + '),
  );
  return `demo judge: these verdicts are placeholders, not real judgments. Put one of ${names.join(', ')} in .env, then run vet init --force`;
}

const JUDGED_STATUSES = new Set<string>(['ok', 'unscored', 'error', 'infra_failure']);

function cacheLine(result: RunEvalsResult): string {
  const cached = result.results.filter((v) => v.cacheHit).length;
  const judged = result.results.filter(
    (v) => JUDGED_STATUSES.has(v.status) && !v.cacheHit && result.model.transport !== 'code',
  ).length;
  return `cache: ${String(cached)} cached, ${String(judged)} judged`;
}

function gateLine({ gate }: RunEvalsResult): string {
  if (gate.tier === 'calibrated') {
    return `gate: calibrated — ${String(gate.calibratedCriteria)}/${String(gate.judgedCriteria)} criteria calibrated (${LOCK_FILE})`;
  }
  return gate.lockPath === null
    ? 'gate: uncalibrated — thresholds are the 0.5 placeholder; run `vet validate` to calibrate'
    : `gate: uncalibrated — ${LOCK_FILE} present; pass --gate to enforce it`;
}

function render(result: RunEvalsResult): string {
  const caseIds = new Set(result.results.map((v) => v.caseId));
  const lines = [...caseIds].map((caseId) => caseWord(result, caseId));
  const { summary, model } = result;
  const flaky = summary.flaky ?? 0;
  lines.push(
    `${String(summary.passed)} passed, ${String(summary.failed)} failed, ${String(summary.unscored)} unscored of ${String(summary.total)}${flaky > 0 ? `, ${String(flaky)} flaky` : ''}${summary.aborted ? ' (aborted)' : ''}`,
    cacheLine(result),
    `model: ${model.resolved === '' ? model.requested : model.resolved} (transport ${model.transport}, pinned: ${String(model.pinned)})`,
    gateLine(result),
  );
  return lines.join('\n');
}

// evals/cases/pending/ is where promote.ts writes auto-promoted cases; the
// loader's default evals/cases/*.jsonl glob never recurses into it, so a case sitting there is otherwise invisible
// until `vet cases review` moves it up a level. A missing pending/ directory (the common case before any
// promotion has happened) counts as 0, not an error.
async function countPendingCases(casesPath: string): Promise<number> {
  const result = await loadCases(join(casesPath, 'pending'));
  return result.ok ? result.cases.length : 0;
}

// Record paths are relative to the config directory with POSIX separators, so the record is portable.
function toPosixRelative(rootDir: string, path: string): string {
  return relative(rootDir, path).split(sep).join('/');
}

// The report model is built from the record just written, on every run: the badge always needs
// it, and the md/html reports share it. A report that cannot be written fails the command
// (exit 2) with the record already on disk.
async function writeReportFiles(input: {
  readonly specs: readonly ReporterSpec[];
  readonly includeCases: boolean;
  readonly rootDir: string;
  readonly cacheDir: string;
  readonly cwd: string;
}): Promise<{ readonly lines: string[]; readonly markdown?: string }> {
  const { specs, rootDir, cacheDir, cwd } = input;
  const textSpecs = specs.filter((spec) => spec.kind !== 'junit');
  const includeCases = input.includeCases && textSpecs.length > 0;
  const record = await readRunRecord(cacheDir);
  if (record === null) {
    throw new VetError(CEV_ERROR_CODES.RUN_NOT_FOUND, `no run record at ${cacheDir}`);
  }
  const inputs = await loadReportInputs({ rootDir, record, includeCases });
  if (textSpecs.length > 0) for (const warning of inputs.warnings) getLogger().warn(warning);
  const model = buildReportModel({
    record,
    criteria: inputs.criteria,
    lock: inputs.lock,
    ...(inputs.cases === undefined ? {} : { cases: inputs.cases }),
    includeCases,
    vetkitVersion: VETKIT_VERSION,
  });
  const lines: string[] = [];
  for (const spec of textSpecs) {
    const target = resolve(cwd, spec.path);
    await writeTextReport(target, spec.kind === 'md' ? renderMarkdown(model) : renderHtml(model));
    lines.push(`report: ${relative(cwd, target)}`);
  }
  await writeBadge(cacheDir, model);
  // The job summary is the same Markdown report, rendered only inside GitHub Actions.
  return process.env['GITHUB_ACTIONS'] === 'true'
    ? { lines, markdown: renderMarkdown(model) }
    : { lines };
}

async function runCommand(options: RunOptions & Readonly<Record<string, unknown>>): Promise<void> {
  const log = getLogger();
  const cwd = process.cwd();
  const repeats = parseRepeat(options.repeat);
  if (options.record !== undefined && options.replay !== undefined) {
    throw new VetError(CEV_ERROR_CODES.CONFIG_INVALID, '--record and --replay are exclusive');
  }
  const replaying = options.replay !== undefined;
  const loaded = await loadVetConfig({
    cwd,
    ...(options.config === undefined ? {} : { configPath: options.config }),
    // A replay answers from the recording, so the config's judge credential is never needed.
    requireCredentials: !replaying,
  });
  for (const warning of loaded.warnings) log.warn(warning);
  const { config, rootDir } = loaded;
  // Missing lock → null (`vet run` then refuses); an invalid one throws (exit 2).
  const lockPath = resolve(rootDir, LOCK_FILE);
  const lock = await readLockOrNull(lockPath);
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
  const { paths } = loaded;
  const criteriaPath = resolve(options.criteria ?? paths.criteria);
  const casesPath = resolve(options.cases ?? paths.cases);
  const pendingCount = await countPendingCases(casesPath);
  log.info(
    `${String(pendingCount)} promoted case(s) pending review in ${join(casesPath, 'pending')} (run \`vet cases review\`)`,
  );
  const { cacheDir } = paths;
  let judge: JudgeV1 = loaded.judge;
  if (options.replay !== undefined) {
    judge = replayJudge(resolve(cwd, options.replay), {
      version: readCliVersion(),
      onWarn: (message) => log.warn(message),
    });
  } else if (options.record !== undefined) {
    judge = recordingJudge(loaded.judge, resolve(cwd, options.record), {
      version: readCliVersion(),
    });
  }
  const demo = isDemoJudge(judge);
  const startedAt = new Date().toISOString();
  const { events: runEvalsEvents, take: takeRunEnd } = deferRunEnd(events);
  let result: RunEvalsResult;
  try {
    result = await runEvals({
      config: {
        criteriaPath,
        casesDir: casesPath,
        judge,
        repeats,
        threshold: config.thresholds.default,
        gate: options.gate === true,
        ci: options.ci === true,
        gatePolicy: {
          ...config.gate,
          allowUnpinned: options.allowUnpinned === true || config.gate.allowUnpinned,
        },
        // Demo verdicts never enter the verdict cache; the run record below is still written.
        ...(demo ? {} : { cacheDir }),
        lockPath,
        // A replay must not be masked by a warm cache, and a recording needs every call made.
        bypassCache:
          options.cache === false || options.replay !== undefined || options.record !== undefined,
      },
      lock,
      signal: controller.signal,
      events: runEvalsEvents,
    });

    // An exit of 1 from unscored verdicts alone is not a scored failure: it exits 3
    // (nothing could be judged), or 0 when --sink records the verdicts for a later drain.
    if (result.exitCode === 1 && !hasScoredFailure(result.results)) {
      result.exitCode = options['sink'] === undefined ? 3 : 0;
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
  await writeReports(
    options.reporter?.find((spec) => spec.kind === 'junit'),
    [{ criteriaPath, result }],
    { cwd },
  );
  const extras: Record<string, unknown> = {};
  const lines: string[] = [];
  for (const finish of finishes) {
    const out = await finish(result);
    Object.assign(extras, out.json);
    lines.push(...(out.lines ?? []));
  }
  // The record is the --json document plus its inputs; partial runs included.
  await writeRunRecord(cacheDir, {
    ...result,
    ...extras,
    criteriaPath: toPosixRelative(rootDir, criteriaPath),
    casesPath: toPosixRelative(rootDir, casesPath),
    startedAt,
    gateRequested: options.gate === true,
  });
  const reports = await writeReportFiles({
    specs: options.reporter ?? [],
    includeCases: options.includeCases === true,
    rootDir,
    cacheDir,
    cwd,
  });
  lines.push(...reports.lines);
  if (reports.markdown !== undefined) {
    await reportToGithub({ result, markdown: reports.markdown, env: process.env });
  }
  if (demo) log.warn(demoHint());
  emit({ ...result, ...extras }, () => [render(result), ...lines].join('\n'));
  if (result.exitCode === CEV_EXIT.UNSCORED_ONLY) {
    const { unscored, total } = result.summary;
    log.error(
      `unscored only: ${String(unscored)} of ${String(total)} cases got no verdict; exit 3 [UNSCORED_ONLY]`,
    );
    log.error(hintFor('UNSCORED_ONLY'));
  }
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
        'criteria file (default: criteria.yaml next to the config, or under evals/ when that directory exists)',
      )
      .option(
        '--cases <dir>',
        'cases directory (default: cases next to the config, or under evals/ when that directory exists)',
      )
      .option(
        '--include-cases',
        'put case ids and (redacted, truncated) case text in md/html reports; no effect without them',
      )
      .option('--gate', 'gate on calibrated thresholds from the lock; refuses (exit 2) without one')
      .option('--ci', 'CI gating: refuse (exit 2) a lock written against an unpinned transport')
      .option('--allow-unpinned', 'let --gate and --ci pass on an unpinned judge transport')
      .option('--no-cache', 'judge every case afresh; neither read nor write the verdict cache')
      .option(
        '--repeat <n>',
        'judge each case n times; a case whose repeats disagree beyond the tolerance band is flaky (default 1)',
      )
      .option('--record <dir>', 'also write every judge response under <dir> for a later --replay')
      .option(
        '--replay <dir>',
        'answer from a --record directory: no judge credential, no network',
      ),
  ).action(async (_options: unknown, command: Command) => {
    await runCommand(command.optsWithGlobals<RunOptions & Readonly<Record<string, unknown>>>());
  });
}
