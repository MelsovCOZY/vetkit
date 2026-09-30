import { EVENT_NAMES } from '@vetkit/core';
import type { EventMap, Events } from '@vetkit/core';
import type { Logger, LogStream } from './logger.ts';
import { getLogger } from './output.ts';
import type { GlobalOptions } from './output.ts';
import { redact } from './redact.ts';

export interface RenderEventsOptions {
  readonly options: GlobalOptions;
  /** Pretty mode writes through this logger (default: the CLI logger, on stderr). */
  readonly logger?: Logger;
  /** NDJSON mode writes here (default: process.stderr). stdout is never touched. */
  readonly stream?: LogStream;
  readonly now?: () => number;
}

const CASE_LINES_PER_SECOND = 10;

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

type Subscribe = (events: Events) => (() => void)[];

function ndjson(stream: LogStream): Subscribe {
  const names = [...Object.values(EVENT_NAMES), 'diag'] as const;
  return (events) =>
    names.map((name) =>
      events.on(name, (payload: EventMap[typeof name]) => {
        stream.write(`${redact(JSON.stringify({ event: name, ...payload }))}\n`);
      }),
    );
}

function pretty(logger: Logger, now: () => number): Subscribe {
  let windowStart = Number.NEGATIVE_INFINITY;
  let shown = 0;
  let skipped = 0;
  const flushSkipped = (): void => {
    if (skipped === 0) return;
    logger.info(`… ${plural(skipped, 'more case')} not shown`);
    skipped = 0;
  };
  // JUDGE_THROTTLED/JUDGE_RETRY diags pair up per retry; they are counted here, kept at
  // debug for --verbose, and summarised as one warn line at run:end (or on unsubscribe).
  let retries = 0;
  let waitedMs = 0;
  let throttleSeen = false;
  const flushThrottle = (): void => {
    if (!throttleSeen) return;
    logger.warn(
      `judge throttled: ${retries} retries, waited ${Math.round(waitedMs)}ms [JUDGE_THROTTLED]`,
    );
    retries = 0;
    waitedMs = 0;
    throttleSeen = false;
  };
  const subscribe: Subscribe = (events) => [
    events.on('run:start', ({ cases, criteria }) => {
      logger.info(`run: ${plural(cases, 'case')} × ${criteria} criteria`);
    }),
    events.on('case:start', ({ caseId, index, total }) => {
      const t = now();
      if (t - windowStart >= 1000) {
        windowStart = t;
        shown = 0;
      }
      if (shown >= CASE_LINES_PER_SECOND) {
        skipped += 1;
        return;
      }
      shown += 1;
      logger.info(`case ${caseId} (${index + 1}/${total})`);
    }),
    events.on('judge:request', ({ caseId, criterionId, stateBytes }) => {
      logger.debug(`judge request ${caseId}/${criterionId}`, { stateBytes });
    }),
    events.on('judge:response', ({ caseId, criterionId, ...counters }) => {
      logger.debug(`judge response ${caseId}/${criterionId}`, counters);
    }),
    events.on('verdict', ({ caseId, criterionId, status, pass, cause }) => {
      logger.debug(`verdict ${caseId}/${criterionId}`, {
        status,
        ...(pass === undefined ? {} : { pass }),
        ...(cause === undefined ? {} : { cause }),
      });
    }),
    events.on('sink:write', ({ sink, records }) => {
      logger.debug(`sink ${sink} wrote ${plural(records, 'record')}`);
    }),
    events.on('outbox:drain', ({ sink, drained, pending }) => {
      logger.debug(`outbox ${sink} drained ${drained}, ${pending} pending`);
    }),
    events.on('run:end', ({ verdicts, exitCode, durationMs }) => {
      flushSkipped();
      flushThrottle();
      logger.info(`run done: ${plural(verdicts, 'verdict')}, exit ${exitCode} in ${durationMs}ms`);
    }),
    events.on('diag', ({ level, code, message, data }) => {
      if (code === 'JUDGE_THROTTLED' || code === 'JUDGE_RETRY') {
        throttleSeen = true;
        if (code === 'JUDGE_RETRY') retries += 1;
        else if (typeof data?.['retryAfterMs'] === 'number') waitedMs += data['retryAfterMs'];
        logger.debug(`${message} [${code}]`, data);
        return;
      }
      logger[level](`${message} [${code}]`, data);
    }),
  ];
  return (events) => {
    const unsubscribers = subscribe(events);
    return [...unsubscribers, flushThrottle];
  };
}

/**
 * Renders core events on stderr: pretty progress by default, NDJSON under
 * `--verbose --json`, nothing under `--quiet`. Returns an unsubscribe function.
 */
export function renderEvents(events: Events, render: RenderEventsOptions): () => void {
  const { options } = render;
  if (options.quiet) return () => {};
  const subscribe =
    options.verbose && options.json
      ? ndjson(render.stream ?? process.stderr)
      : pretty(render.logger ?? getLogger(), render.now ?? Date.now);
  const unsubscribers = subscribe(events);
  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
  };
}
