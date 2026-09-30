import { createEvents } from '@vetkit/core';
import type { Events } from '@vetkit/core';
import { safeParseJson } from '@vetkit/spec';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from './logger.ts';
import { renderEvents } from './render-events.ts';

function parseJson(text: string): unknown {
  const result = safeParseJson<unknown>(text, {});
  if (!result.ok) throw result.error;
  return result.value;
}

function sink(): { stream: { write: (chunk: string) => boolean }; lines: string[] } {
  const lines: string[] = [];
  return {
    stream: {
      write: (chunk: string) => {
        lines.push(...chunk.split('\n').filter((line) => line !== ''));
        return true;
      },
    },
    lines,
  };
}

function fakeRun(events: Events, cases = 1): void {
  events.emit('run:start', { cases, criteria: 1 });
  for (let index = 0; index < cases; index += 1) {
    const caseId = `c${index}`;
    events.emit('case:start', { caseId, index, total: cases });
    events.emit('judge:request', { caseId, criterionId: 'k1', stateBytes: 10 });
    events.emit('judge:response', {
      caseId,
      criterionId: 'k1',
      status: 200,
      durationMs: 5,
      inputTokens: 3,
      cacheHit: false,
    });
    events.emit('verdict', { caseId, criterionId: 'k1', status: 'ok', pass: true });
  }
  events.emit('run:end', { cases, verdicts: cases, exitCode: 0, durationMs: 9 });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('renderEvents', () => {
  it('renders pretty progress lines through the logger by default', () => {
    const { stream, lines } = sink();
    const events = createEvents();
    renderEvents(events, { options: {}, logger: createLogger({ stream, color: false }) });
    fakeRun(events);
    expect(lines.some((line) => line.startsWith('info ') && line.includes('1 case'))).toBe(true);
    expect(lines.some((line) => line.includes('c0'))).toBe(true);
    expect(lines.some((line) => line.includes('exit 0'))).toBe(true);
  });

  it('writes one NDJSON line per event to the stream under --verbose --json', () => {
    const { stream, lines } = sink();
    const events = createEvents();
    renderEvents(events, { options: { verbose: true, json: true }, stream });
    fakeRun(events);
    events.diag('warn', 'CACHE_MISS', 'cache miss', { misses: 1 });
    const records = lines.map((line) => parseJson(line));
    expect(records).toHaveLength(7);
    expect(records[0]).toEqual({ event: 'run:start', cases: 1, criteria: 1 });
    expect(records[3]).toMatchObject({ event: 'judge:response', status: 200, cacheHit: false });
    expect(records[6]).toEqual({
      event: 'diag',
      level: 'warn',
      code: 'CACHE_MISS',
      message: 'cache miss',
      data: { misses: 1 },
    });
  });

  it('sends NDJSON to process.stderr and never to stdout by default', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const events = createEvents();
    renderEvents(events, { options: { verbose: true, json: true } });
    fakeRun(events);
    expect(stderr).toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
  });

  it('never writes pretty progress to stdout', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const events = createEvents();
    renderEvents(events, { options: {}, logger: createLogger({ color: false }) });
    fakeRun(events);
    expect(stderr).toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
  });

  it('drops every event under --quiet', () => {
    const { stream, lines } = sink();
    const events = createEvents();
    renderEvents(events, {
      options: { quiet: true, verbose: true, json: true },
      stream,
      logger: createLogger({ stream, color: false }),
    });
    fakeRun(events);
    events.diag('error', 'X', 'x');
    expect(lines).toEqual([]);
  });

  it('renders diag warnings at warn level in pretty mode', () => {
    const { stream, lines } = sink();
    const events = createEvents();
    renderEvents(events, { options: {}, logger: createLogger({ stream, color: false }) });
    events.diag('warn', 'SLOW_JUDGE', 'judge is slow', { durationMs: 9000 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^warn .*judge is slow/);
  });

  it('throttles case progress to 10 lines per second and summarises the rest', () => {
    const { stream, lines } = sink();
    const events = createEvents();
    renderEvents(events, {
      options: {},
      logger: createLogger({ stream, color: false }),
      now: () => 1000,
    });
    fakeRun(events, 100);
    const progress = lines.filter((line) => /case c\d+/.test(line));
    expect(progress).toHaveLength(10);
    expect(lines.some((line) => line.includes('90 more case'))).toBe(true);
  });

  it('logs cause status/errorType at debug level for an unscored verdict, never body or key', () => {
    const { stream, lines } = sink();
    const events = createEvents();
    renderEvents(events, {
      options: {},
      logger: createLogger({ stream, color: false, level: 'debug' }),
    });
    events.emit('verdict', {
      caseId: 'c0',
      criterionId: 'k1',
      status: 'unscored',
      cause: { status: 403, errorType: 'no_providers_available' },
    });
    const verdictLine = lines.find((line) => line.includes('verdict c0/k1'));
    expect(verdictLine).toContain('403');
    expect(verdictLine).toContain('no_providers_available');
    expect(verdictLine).not.toContain('body');
    expect(verdictLine).not.toContain('secret');
  });

  it('stops rendering after the returned unsubscribe is called', () => {
    const { stream, lines } = sink();
    const events = createEvents();
    const stop = renderEvents(events, { options: { verbose: true, json: true }, stream });
    stop();
    fakeRun(events);
    expect(lines).toEqual([]);
  });
});

const throttle = (events: Events, n: number): void => {
  for (let i = 1; i <= n; i += 1) {
    events.diag('warn', 'JUDGE_THROTTLED', 'judge throttled, backing off', {
      retryAfterMs: 1.5,
      ceiling: 1,
    });
    events.diag('info', 'JUDGE_RETRY', 'retrying judge request', { attempt: i });
  }
};
const bare = (line: string): string => line.replace(/^(debug|info|warn|error) /, '');

describe('throttle summary', () => {
  it('pretty mode aggregates JUDGE_THROTTLED/JUDGE_RETRY diags into one warn line at run:end', () => {
    const { stream, lines } = sink();
    const events = createEvents();
    renderEvents(events, { options: {}, logger: createLogger({ stream, color: false }) });
    events.emit('run:start', { cases: 1, criteria: 1 });
    throttle(events, 7);
    events.emit('run:end', { cases: 1, verdicts: 1, exitCode: 3, durationMs: 9 });
    const summary = lines.filter((line) =>
      /^judge throttled: 7 retries, waited 11ms \[JUDGE_THROTTLED\]$/.test(bare(line)),
    );
    expect(summary).toHaveLength(1);
    expect(summary[0]).toMatch(/^warn /);
    expect(lines.filter((line) => line.includes('[JUDGE_RETRY]'))).toHaveLength(0);
    expect(lines.filter((line) => line.includes('backing off'))).toHaveLength(0);
    const done = lines.findIndex((line) => line.includes('run done:'));
    expect(lines.indexOf(summary[0] ?? '')).toBeLessThan(done);
    expect(done).toBeGreaterThan(-1);
  });

  it('no throttle -> no summary line', () => {
    const { stream, lines } = sink();
    const events = createEvents();
    renderEvents(events, { options: {}, logger: createLogger({ stream, color: false }) });
    fakeRun(events);
    expect(lines.filter((line) => line.includes('judge throttled'))).toHaveLength(0);
  });

  it('the summary is flushed by the unsubscribe function when run:end never fires', () => {
    const { stream, lines } = sink();
    const events = createEvents();
    const stop = renderEvents(events, {
      options: {},
      logger: createLogger({ stream, color: false }),
    });
    throttle(events, 2);
    stop();
    expect(
      lines.filter((line) => line.includes('judge throttled: 2 retries, waited 3ms')),
    ).toHaveLength(1);
  });

  it('--verbose keeps the per-attempt lines at debug level', () => {
    const { stream, lines } = sink();
    const events = createEvents();
    renderEvents(events, {
      options: { verbose: true },
      logger: createLogger({ stream, color: false, level: 'debug' }),
    });
    events.emit('run:start', { cases: 1, criteria: 1 });
    throttle(events, 7);
    events.emit('run:end', { cases: 1, verdicts: 1, exitCode: 3, durationMs: 9 });
    expect(
      lines.filter((line) => /^debug .*\[(JUDGE_THROTTLED|JUDGE_RETRY)\]/.test(line)),
    ).toHaveLength(14);
    expect(lines.filter((line) => line.includes('judge throttled: 7 retries'))).toHaveLength(1);
  });

  it('NDJSON mode is unchanged: every diag is its own line and no summary is added', () => {
    const { stream, lines } = sink();
    const events = createEvents();
    renderEvents(events, { options: { verbose: true, json: true }, stream });
    events.emit('run:start', { cases: 1, criteria: 1 });
    throttle(events, 3);
    events.emit('run:end', { cases: 1, verdicts: 1, exitCode: 3, durationMs: 9 });
    expect(lines.filter((line) => line.includes('"event":"diag"'))).toHaveLength(6);
    expect(lines.filter((line) => line.includes('judge throttled:'))).toHaveLength(0);
  });

  it('other diag codes still print immediately at their level', () => {
    const { stream, lines } = sink();
    const events = createEvents();
    renderEvents(events, { options: {}, logger: createLogger({ stream, color: false }) });
    events.diag('warn', 'NO_CASES', 'no cases found');
    expect(lines).toEqual(['warn no cases found [NO_CASES]']);
  });
});
