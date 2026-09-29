// `vet run --sink <names>`: after the run, every verdict (partial on SIGINT)
// is enqueued in the durable outbox under <cacheDir>/outbox, drained to the named sinks and
// reconciled. The counts merge into the run's result: `sinks.<name> = {accepted, skipped, rejected}`
// for this drain and `outbox = {produced, acknowledged, skipped, dead}` as outbox-file totals, which
// add up across runs so a second run shows the drained backlog. Retained pending
// items only warn on stderr; the exit code stays the run's.
import { join, resolve } from 'node:path';
import { createEvents, createOutbox } from '@vetkit/core';
import { CEV_ERROR_CODES, VetError } from '@vetkit/spec';
import type { Command } from 'commander';
import { getLogger } from '../output.ts';
import { renderEvents } from '../render-events.ts';
import { configuredSinkNames, resolveSinks, type ResolvedSink } from '../sinks.ts';
import { runHooks, type RunHook, type RunHookContext, type RunHookFinish } from './run.ts';

function parseNames(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  return [...new Set(raw.split(',').map((name) => name.trim()))].filter((name) => name !== '');
}

function finishFor(ctx: RunHookContext, sinks: readonly ResolvedSink[]): RunHookFinish {
  return async (result) => {
    const outboxDir = join(ctx.config.cacheDir, 'outbox');
    const outbox = createOutbox({ dir: resolve(ctx.rootDir, outboxDir) });
    await outbox.enqueue(result.results, { targets: sinks.map((s) => s.sink.id) });
    const drained = await outbox.drain(sinks.map((s) => s.sink));
    const totals = await outbox.reconcile({ sinks: sinks.map((s) => s.sink.id) });

    const events = createEvents();
    const stopRendering = renderEvents(events, { options: ctx.options });
    const counts: Record<string, { accepted: number; skipped: number; rejected: number }> = {};
    const lines: string[] = [];
    let pending = 0;
    for (const { name, sink } of sinks) {
      const d = drained.find((r) => r.sink === sink.id);
      if (d === undefined) continue;
      events.emit('outbox:drain', { sink: d.sink, drained: d.acknowledged, pending: d.pending });
      const accepted = d.acknowledged - d.skipped;
      counts[name] = { accepted, skipped: d.skipped, rejected: d.dead + d.pending };
      pending += d.pending;
      lines.push(
        `sink ${name}: ${String(accepted)} accepted, ${String(d.skipped)} skipped, ${String(d.dead + d.pending)} rejected`,
      );
    }
    stopRendering();
    lines.push(
      `outbox totals: ${String(totals.produced)} produced, ${String(totals.acknowledged)} acknowledged (${String(totals.skipped)} skipped), ${String(totals.dead)} dead`,
    );
    if (pending > 0) {
      getLogger().warn(
        `${String(pending)} verdicts pending in ${outboxDir}; rerun with --sink to drain`,
      );
    }
    return { json: { sinks: counts, outbox: totals }, lines };
  };
}

const sinkHook: RunHook = (ctx) => {
  const raw = ctx.options['sink'];
  if (raw === undefined) return Promise.resolve(undefined);
  const configured = configuredSinkNames(ctx.config);
  const names = parseNames(raw);
  try {
    if (names.length === 0) {
      throw new VetError(
        CEV_ERROR_CODES.CONFIG_UNKNOWN_SINK,
        `--sink needs a comma list of sink names; configured: ${configured.join(', ') || '(none)'}`,
      );
    }
    return Promise.resolve(finishFor(ctx, resolveSinks(ctx.config, names)));
  } catch (error) {
    if (VetError.isInstance(error) && error.code === CEV_ERROR_CODES.CONFIG_UNKNOWN_SINK) {
      getLogger().error(`configured sinks: ${configured.join(', ') || '(none)'}`);
    }
    throw error;
  }
};

export function registerRunSinks(program: Command): void {
  const run = program.commands.find((command) => command.name() === 'run');
  if (run === undefined) return;
  run.option('--sink [names]', 'comma list of configured sinks to write verdicts to');
  // runHooks is module-global: a second program built in-process must not add the hook twice.
  if (!runHooks.includes(sinkHook)) runHooks.push(sinkHook);
}
