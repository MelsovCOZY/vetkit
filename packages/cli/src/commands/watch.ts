// `vet watch`: docs/contracts/j7.md, docs/watch.md. Samples a live OTel stream through the J5
// receiver (packages/source-otlp startReceiver), judges the sample (runWatch),
// promotes failures into evals/cases/pending/ (promoteFailure) and prints one
// coverage summary on exit. The one documented exception to the CLI-wide SIGINT->130 rule
// (docs/contracts/j7.md "Exit behaviour"): first SIGINT drains once and exits 0, second exits
// 130 immediately. A receiver bind failure is RECEIVER_BIND (exit 2); an out-of-range --sample
// (and no vetkit.config.ts watch.sampleRate to fall back to) is WATCH_CONFIG (exit 2).
import { join, resolve } from 'node:path';
import {
  createOutbox,
  createSampler,
  decideVerdict,
  judgeCase,
  loadCriteria,
  promoteFailure,
  runWatch,
  type CoverageSummary,
  type JudgeCaseFn,
} from '@vetkit/core';
import { startReceiver, type Receiver } from '@vetkit/source-otlp';
import {
  CEV_ERROR_CODES,
  defineSource,
  VetError,
  type Case,
  type NormalizedTrace,
  type SourceV1,
  type Verdict,
} from '@vetkit/spec';
import type { Command } from 'commander';
import { loadVetConfig } from '../config-load.ts';
import { CEV_EXIT, emit, getLogger, type GlobalOptions } from '../output.ts';
import { configuredSinkNames, resolveSinks } from '../sinks.ts';

interface WatchOptions extends GlobalOptions {
  readonly sample?: string;
  readonly port: string;
  readonly maxInFlight?: string;
  readonly promote: boolean;
  readonly sink?: string;
}

// Builds the SourceV1 the loop pulls from and the onRequest callback startReceiver calls per
// trace: a small queue plus a wake-on-arrival wait, the same shape as the CLI's other
// receiver-backed source (packages/cli/src/commands/init-otlp.ts's receiverSource, private to
// that file — this bead's contract keeps the receiver module itself untouched, so the wrapping
// is duplicated here rather than reaching into that file).
function queuedReceiverSource(): {
  readonly source: SourceV1;
  readonly onRequest: (trace: NormalizedTrace) => void;
} {
  const queue: NormalizedTrace[] = [];
  let wake: (() => void) | undefined;
  const source = defineSource({
    specVersion: 'v1',
    id: 'otlp/watch-receiver',
    capabilities: { streaming: true, content: 'maybe' },
    async *doRead({ signal }) {
      for (;;) {
        if (queue.length > 0) {
          // oxlint-disable-next-line typescript/no-non-null-assertion
          yield queue.shift()!;
          continue;
        }
        if (signal?.aborted === true) return;
        // oxlint-disable-next-line no-await-in-loop
        await new Promise<void>((resolvePromise) => {
          const onAbort = (): void => resolvePromise();
          signal?.addEventListener('abort', onAbort, { once: true });
          wake = (): void => {
            signal?.removeEventListener('abort', onAbort);
            resolvePromise();
          };
        });
      }
    },
  });
  return {
    source,
    onRequest: (trace) => {
      queue.push(trace);
      wake?.();
    },
  };
}

async function bindReceiver(port: number): Promise<{ receiver: Receiver; source: SourceV1 }> {
  const { source, onRequest } = queuedReceiverSource();
  let receiver: Receiver;
  try {
    receiver = await startReceiver({ port, host: '127.0.0.1', onRequest });
  } catch (cause) {
    throw new VetError(
      CEV_ERROR_CODES.RECEIVER_BIND,
      `cannot bind the OTLP receiver to port ${String(port)}`,
      { cause },
    );
  }
  return { receiver, source };
}

const PROV_KEYS = [
  'traceId',
  'spanId',
  'responseId',
  'observationId',
  'dialect',
  'schemaUrl',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Same shape run.ts's private verdictProvenance() builds for `vet run` (picks the six
// verdict-provenance schema keys off the case's provenance, case.traceId winning): duplicated
// here rather than imported, since exporting it would mean touching run.ts/index.ts, and
// this bead's owned paths don't include either.
function caseProvenance(evalCase: Case): Verdict['provenance'] | undefined {
  const source = isRecord(evalCase.provenance) ? evalCase.provenance : {};
  const out: NonNullable<Verdict['provenance']> = {};
  for (const key of PROV_KEYS) {
    const value = source[key];
    if (typeof value === 'string') out[key] = value;
  }
  if (evalCase.traceId !== undefined) out.traceId = evalCase.traceId;
  return Object.keys(out).length === 0 ? undefined : out;
}

export function renderSummary(summary: CoverageSummary, promotedSkipped: number): string {
  const outage =
    summary.unscored > 0
      ? [
          `judge outage: ${summary.unscoredCauses.join(' / ')} x ${String(summary.unscored)}; unscored ${String(summary.unscored)} sampled trace(s), failing traces may have been missed`,
        ]
      : [];
  return [
    `seen ${String(summary.seen)}, sampled ${String(summary.sampled)}, judged ${String(summary.judged)}`,
    `promoted ${String(summary.promoted)} (skipped ${String(promotedSkipped)}), produced ${String(summary.produced)}, acknowledged ${String(summary.acknowledged)}`,
    ...outage,
  ].join('\n');
}

async function watchCommand(options: WatchOptions): Promise<void> {
  const log = getLogger();
  const loaded = await loadVetConfig({ cwd: process.cwd() });
  for (const warning of loaded.warnings) log.warn(warning);
  const { config, rootDir, judge } = loaded;

  const sampleRate =
    options.sample === undefined ? config.watch.sampleRate : Number(options.sample);
  if (
    sampleRate === undefined ||
    !Number.isFinite(sampleRate) ||
    sampleRate < 0 ||
    sampleRate > 1
  ) {
    throw new VetError(
      CEV_ERROR_CODES.WATCH_CONFIG,
      `--sample must be within 0..1 (got ${options.sample ?? 'unset, and no watch.sampleRate in vetkit.config.ts'})`,
    );
  }
  const port = Number(options.port);
  const maxInFlight =
    options.maxInFlight === undefined ? config.watch.maxInFlight : Number(options.maxInFlight);
  const promoteOn: 'fail' | 'never' = options.promote ? 'fail' : 'never';

  const criteriaPath = resolve(rootDir, 'evals/criteria.yaml');
  const casesPath = resolve(rootDir, 'evals/cases');
  const cacheDir = resolve(rootDir, config.cacheDir);
  const inclusionPath = join(cacheDir, 'watch', 'inclusion.jsonl');

  const loadedCriteria = await loadCriteria(criteriaPath);
  if (!loadedCriteria.ok) {
    const issue = loadedCriteria.issues[0];
    throw new VetError(
      issue?.code ?? CEV_ERROR_CODES.CRITERIA_INVALID,
      `cannot load ${criteriaPath}: ${issue?.message ?? 'invalid'}`,
    );
  }
  const criteria = loadedCriteria.criteria.filter((c) => c.enabled !== false);

  const sinkNames =
    options.sink === undefined
      ? configuredSinkNames(config)
      : options.sink
          .split(',')
          .map((name) => name.trim())
          .filter((name) => name !== '');
  const sinks = resolveSinks(config, sinkNames).map((r) => r.sink);

  const { receiver, source } = await bindReceiver(port);
  log.info(JSON.stringify({ listening: { port: receiver.port } }));

  const outbox = createOutbox({ dir: join(cacheDir, 'outbox') });
  const thresholdFor = (criterionId: string): number =>
    config.thresholds.perCriterion[criterionId] ?? config.thresholds.default;
  // judgeCase alone never sets `pass` (root DECISION: that pure math is decideVerdict, a
  // separate core seam `vet run` calls through its own lock-aware `decide()`); watch has no
  // lock to read calibrated thresholds from, so it calls decideVerdict directly with the
  // config's threshold, the same math run.ts uses when a criterion has no lock entry.
  const judgeFn: JudgeCaseFn = async ({ case: c, criteria: caseCriteria, signal }) => {
    const verdicts = await judgeCase({ judge, case: c, criteria: caseCriteria, signal });
    const byId = new Map(caseCriteria.map((crit) => [crit.id, crit]));
    const provenance = caseProvenance(c);
    return verdicts.map((v) => {
      const withProvenance = provenance === undefined ? v : { ...v, provenance };
      const crit = byId.get(v.criterionId);
      if (
        crit === undefined ||
        crit.grader?.kind === 'code' ||
        v.status !== 'ok' ||
        v.answer === undefined
      ) {
        return withProvenance;
      }
      return { ...withProvenance, ...decideVerdict(v, crit, thresholdFor(v.criterionId)) };
    });
  };

  let promotedSkipped = 0;
  const onVerdict =
    promoteOn === 'fail'
      ? (verdict: Verdict, evalCase: Case): boolean => {
          const wasFailure = verdict.status === 'ok' && verdict.pass === false;
          const promoted = promoteFailure(verdict, evalCase, casesPath);
          if (wasFailure && !promoted) promotedSkipped += 1;
          return promoted;
        }
      : undefined;

  // First SIGINT stops accepting (receiver.close() waits for requests already being served),
  // and only once that has settled does the source end, so every trace answered with 200 is
  // still in the queue the loop drains. The loop's hard-abort `controller` is never fired.
  const controller = new AbortController();
  const stopController = new AbortController();
  let sigints = 0;
  const onSigint = (): void => {
    sigints += 1;
    // Second SIGINT: exit 130 immediately, the CLI-wide rule (docs/contracts/j7.md "Exit
    // behaviour"). The first drains gracefully and the normal return handles the exit-0 path.
    if (sigints >= 2) process.exit(CEV_EXIT.SIGINT);
    void receiver.close().then(() => stopController.abort());
  };
  process.on('SIGINT', onSigint);

  let summary: CoverageSummary;
  try {
    summary = await runWatch({
      source,
      sampler: createSampler({
        sampleRate,
        inclusionPath,
        ...(config.watch.upstreamSampleRate === undefined
          ? {}
          : { upstreamSampleRate: config.watch.upstreamSampleRate }),
      }),
      judge: judgeFn,
      criteria,
      outbox,
      sinks,
      options: {
        sampleRate,
        maxInFlight,
        promoteOn,
        inclusionPath,
        promotedDir: casesPath,
        ...(config.watch.upstreamSampleRate === undefined
          ? {}
          : { upstreamSampleRate: config.watch.upstreamSampleRate }),
      },
      signal: controller.signal,
      stop: stopController.signal,
      ...(onVerdict === undefined ? {} : { onVerdict }),
    });
  } finally {
    process.off('SIGINT', onSigint);
    await receiver.close();
  }

  const document = { ...summary, promotedSkipped };
  emit(document, () => renderSummary(summary, promotedSkipped));
}

export function registerWatch(program: Command): Command {
  return program
    .command('watch')
    .description('sample live OTel traces, judge them, and promote failures into regression cases')
    .option('--sample <rate>', 'sample rate 0..1 (default: vetkit.config.ts watch.sampleRate)')
    .option('--port <n>', 'OTLP/HTTP receiver port', '4318')
    .option('--max-in-flight <n>', 'concurrent judge calls in flight (default: vetkit.config.ts)')
    .option('--no-promote', 'never write failing traces to evals/cases/pending/')
    .option(
      '--sink [names]',
      'comma list of configured sinks to drain to (default: all configured)',
    )
    .action(async (_options: unknown, command: Command) => {
      await watchCommand(command.optsWithGlobals<WatchOptions>());
    });
}
