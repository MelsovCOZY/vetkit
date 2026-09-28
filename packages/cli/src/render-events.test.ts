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

  it('stops rendering after the returned unsubscribe is called', () => {
    const { stream, lines } = sink();
    const events = createEvents();
    const stop = renderEvents(events, { options: { verbose: true, json: true }, stream });
    stop();
    fakeRun(events);
    expect(lines).toEqual([]);
  });
});
