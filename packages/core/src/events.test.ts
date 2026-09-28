import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createEvents, EVENT_NAMES } from './events.ts';
import type { DiagEvent, EventMap, EventName, Events } from './events.ts';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

// Text-bearing keys a payload must never carry (redaction by construction).
const FORBIDDEN_KEYS = /^(state|instructions|answer|prompt|messages)$/;

function forbiddenKeys(value: unknown, path = ''): string[] {
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => [
    ...(FORBIDDEN_KEYS.test(key) ? [`${path}${key}`] : []),
    ...forbiddenKeys(child, `${path}${key}.`),
  ]);
}

// A stand-in for runEvals: one case, one criterion, one sink write and drain.
function fakeRun(events: Events): void {
  events.emit('run:start', { cases: 1, criteria: 1 });
  events.emit('case:start', { caseId: 'c1', index: 0, total: 1 });
  events.emit('judge:request', { caseId: 'c1', criterionId: 'k1', stateBytes: 120 });
  events.emit('judge:response', {
    caseId: 'c1',
    criterionId: 'k1',
    status: 200,
    durationMs: 42,
    inputTokens: 30,
    cacheHit: false,
  });
  events.emit('verdict', { caseId: 'c1', criterionId: 'k1', status: 'ok', pass: true });
  events.emit('sink:write', { sink: 'jsonl', records: 1 });
  events.emit('outbox:drain', { sink: 'jsonl', drained: 1, pending: 0 });
  events.emit('run:end', { cases: 1, verdicts: 1, exitCode: 0, durationMs: 50 });
}

const ALL_NAMES: readonly EventName[] = Object.values(EVENT_NAMES);

describe('createEvents', () => {
  it('names every run event in EVENT_NAMES', () => {
    for (const name of [
      'run:start',
      'case:start',
      'judge:request',
      'judge:response',
      'verdict',
      'sink:write',
      'outbox:drain',
      'run:end',
    ]) {
      expect(ALL_NAMES).toContain(name);
    }
  });

  it('fires each event exactly once in a fake run', () => {
    const events = createEvents();
    const counts = new Map<string, number>();
    for (const name of ALL_NAMES) {
      events.on(name, () => counts.set(name, (counts.get(name) ?? 0) + 1));
    }
    fakeRun(events);
    for (const name of ALL_NAMES) expect(counts.get(name), name).toBe(1);
  });

  it('delivers the judge:response counters to a subscriber', () => {
    const events = createEvents();
    const seen: EventMap['judge:response'][] = [];
    events.on('judge:response', (payload) => seen.push(payload));
    fakeRun(events);
    expect(seen).toEqual([
      {
        caseId: 'c1',
        criterionId: 'k1',
        status: 200,
        durationMs: 42,
        inputTokens: 30,
        cacheHit: false,
      },
    ]);
  });

  it('carries no state/instructions/answer/prompt/messages keys in any payload', () => {
    const events = createEvents();
    const payloads: unknown[] = [];
    for (const name of ALL_NAMES) events.on(name, (payload) => payloads.push(payload));
    events.on('diag', (payload) => payloads.push(payload));
    fakeRun(events);
    events.diag('info', 'CACHE_STATS', 'cache stats', { hits: 3, bytes: 1024 });
    expect(payloads.length).toBeGreaterThan(ALL_NAMES.length);
    expect(payloads.flatMap((payload) => forbiddenKeys(payload))).toEqual([]);
  });

  it('keeps running when a listener throws, forwarding the failure to diag warn', () => {
    const events = createEvents();
    const diags: DiagEvent[] = [];
    events.on('diag', (payload) => diags.push(payload));
    events.on('case:start', () => {
      throw new Error('listener boom');
    });
    const ends: unknown[] = [];
    events.on('run:end', (payload) => ends.push(payload));
    expect(() => fakeRun(events)).not.toThrow();
    expect(ends).toHaveLength(1);
    expect(diags).toHaveLength(1);
    expect(diags[0]?.level).toBe('warn');
    expect(diags[0]?.data).toEqual({ listenerErrors: 1 });
  });

  it('still calls later listeners after an earlier one throws', () => {
    const events = createEvents();
    let called = 0;
    events.on('verdict', () => {
      throw new Error('first');
    });
    events.on('verdict', () => {
      called += 1;
    });
    fakeRun(events);
    expect(called).toBe(1);
  });

  it('does not recurse when a diag listener itself throws', () => {
    const events = createEvents();
    events.on('diag', () => {
      throw new Error('diag boom');
    });
    expect(() => events.diag('warn', 'X', 'x')).not.toThrow();
  });

  it('once() fires a listener a single time', () => {
    const events = createEvents();
    let called = 0;
    events.once('case:start', () => {
      called += 1;
    });
    fakeRun(events);
    fakeRun(events);
    expect(called).toBe(1);
  });

  it('off() removes a listener', () => {
    const events = createEvents();
    let called = 0;
    const listener = (): void => {
      called += 1;
    };
    events.on('run:start', listener);
    events.off('run:start', listener);
    fakeRun(events);
    expect(called).toBe(0);
  });

  it('on() returns an unsubscribe function', () => {
    const events = createEvents();
    let called = 0;
    const unsubscribe = events.on('run:end', () => {
      called += 1;
    });
    unsubscribe();
    fakeRun(events);
    expect(called).toBe(0);
  });

  it('emits diag as {level, code, message, data}', () => {
    const events = createEvents();
    const diags: DiagEvent[] = [];
    events.on('diag', (payload) => diags.push(payload));
    events.diag('debug', 'OUTBOX_SIZE', 'outbox size', { pending: 4 });
    expect(diags).toEqual([
      { level: 'debug', code: 'OUTBOX_SIZE', message: 'outbox size', data: { pending: 4 } },
    ]);
  });

  it('emits with no listeners without throwing', () => {
    const events = createEvents();
    expect(() => fakeRun(events)).not.toThrow();
    expect(() => events.diag('error', 'X', 'x')).not.toThrow();
  });
});

describe('library packages never log', () => {
  it('has no console.* call in packages/*/src outside the cli', () => {
    const grep = spawnSync(
      'grep',
      ['-rn', String.raw`console\.`, 'packages', '--include=*.ts', '--exclude=*.test.ts'],
      { cwd: repoRoot, encoding: 'utf8' },
    );
    // grep exits 1 when nothing matches, 2 on error.
    expect(grep.status).not.toBe(2);
    const hits = grep.stdout
      .split('\n')
      .filter((line) => line !== '')
      .filter((line) => /^packages\/[^/]+\/src\//.test(line))
      .filter((line) => !line.startsWith('packages/cli/'));
    expect(hits).toEqual([]);
  });
});
