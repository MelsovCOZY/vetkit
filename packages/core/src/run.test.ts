import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  CEV_ERROR_CODES,
  VetError,
  type Answer,
  type Case,
  type Criterion,
  type JudgeResponse,
  type JudgeV1,
  type Lock,
  type LockCriterion,
  validateJson,
  verdictSchema,
} from '@vetkit/spec';
import type { Limiter } from './judge/pacing.ts';
import { createEvents, EVENT_NAMES, type EventMap, type Events } from './events.ts';
import { loadCriteria } from './criteria/load.ts';
import { evaluateGate } from './gate.ts';
import { runEvals, runJudge, type RunConfig, type RunVerdict } from './run.ts';
import { calibrate, type CalibrationLabel } from './validate/calibrate.ts';
import { buildLock, readLock, writeLockAtomic } from './validate/lock.ts';

// ---------- fixtures ----------

const BOOL_YAML = `  - id: answers-question
    type: boolean
    instructions: Does the reply answer the question?
    escape: The reply is empty.
    polarity: pass_when_true
    channel: outcome
    provenance: { traceIds: [] }
`;
const NEG_YAML = `  - id: is-rude
    type: boolean
    instructions: Is the reply rude?
    escape: The reply is empty.
    polarity: pass_when_false
    channel: safety
    provenance: { traceIds: [] }
`;
const CHOICE_YAML = `  - id: tone
    type: choice
    instructions: Which tone does the reply take?
    criteria:
      polite: The reply is courteous.
      rude: The reply is insulting.
    passWhen: [polite]
    escape: The reply has no tone.
    polarity: pass_when_true
    channel: quality
    provenance: { traceIds: [] }
`;
const SCORE_YAML = `  - id: helpfulness
    type: score
    instructions: How helpful is the reply?
    criteria: [not helpful, somewhat helpful, very helpful]
    polarity: pass_when_true
    channel: quality
    provenance: { traceIds: [] }
`;
const CODE_YAML = `  - id: sum-correct
    type: boolean
    instructions: Is the sum correct?
    escape: No number given.
    polarity: pass_when_true
    channel: outcome
    provenance: { traceIds: [] }
    checkable: math
    grader: { kind: code, check: numeric }
`;

type CaseLine = Omit<Case, 'provenance' | 'tags'> & Partial<Pick<Case, 'provenance' | 'tags'>>;

async function suite(
  criteriaYaml: string[],
  cases: CaseLine[],
): Promise<Pick<RunConfig, 'criteriaPath' | 'casesDir'>> {
  const dir = await mkdtemp(join(tmpdir(), 'vetkit-run-'));
  const criteriaPath = join(dir, 'criteria.yaml');
  await writeFile(criteriaPath, `criteria:\n${criteriaYaml.join('')}`);
  const casesDir = join(dir, 'cases');
  await mkdir(casesDir);
  const lines = cases.map((c) => JSON.stringify({ provenance: {}, tags: [], ...c }));
  await writeFile(join(casesDir, 'cases.jsonl'), `${lines.join('\n')}\n`);
  return { criteriaPath, casesDir };
}

function yes(p: number): Answer {
  const rest = Math.max(0, 1 - p - 0.01);
  return {
    type: 'choice',
    choice: p >= 0.5 ? 'yes' : 'no',
    confidence: Math.max(p, rest),
    probabilities: { yes: p, no: rest, escape: 0.01 },
  };
}
function escaped(): Answer {
  return {
    type: 'choice',
    choice: 'escape',
    confidence: 0.8,
    probabilities: { yes: 0.1, no: 0.1, escape: 0.8 },
  };
}
function tone(label: string): Answer {
  return {
    type: 'choice',
    choice: label,
    confidence: 0.9,
    probabilities: {
      polite: label === 'polite' ? 0.9 : 0.05,
      rude: label === 'rude' ? 0.9 : 0.05,
      escape: 0.05,
    },
  };
}
function score(s: number): Answer {
  return { type: 'score', score: s, confidence: 0.5, legend: {}, probabilities: {} };
}

type Script = Record<string, Record<string, Answer> | 'throw'>;

/** Subscribes to every bus event; names lists them in order, diags as `diag:<code>`. */
function collect(): { events: Events; names: string[] } {
  const events = createEvents();
  const names: string[] = [];
  for (const name of Object.values(EVENT_NAMES)) events.on(name, () => names.push(name));
  events.on('diag', ({ code }) => names.push(`diag:${code}`));
  return { events, names };
}

function scriptedJudge(
  script: Script,
  opts: { pinned?: boolean; transport?: string; onCall?: () => void } = {},
): { judge: JudgeV1; doJudge: ReturnType<typeof vi.fn<JudgeV1['doJudge']>> } {
  const pinned = opts.pinned ?? true;
  const transport = opts.transport ?? 'fake-transport';
  const doJudge = vi.fn<JudgeV1['doJudge']>((req) => {
    opts.onCall?.();
    const entry = script[req.state];
    if (entry === undefined || entry === 'throw') {
      return Promise.reject(new VetError(CEV_ERROR_CODES.JUDGE_UNAVAILABLE, 'down'));
    }
    const answers: Record<string, Answer> = {};
    for (const key of Object.keys(req.questions)) {
      const a = entry[key];
      if (a !== undefined) answers[key] = a;
    }
    const response: JudgeResponse = {
      answers,
      usage: { inputTokens: 1, outputTokens: 0 },
      model: { requested: 'fake/jev', resolved: 'fake/jev-1', transport, pinned },
    };
    return Promise.resolve(response);
  });
  const judge: JudgeV1 = {
    specVersion: 'v1',
    id: 'fake',
    capabilities: {
      questionTypes: ['boolean', 'choice', 'score'],
      maxStateTokens: 32_000,
      pinned,
      transport,
      model: 'fake/jev',
    },
    doJudge,
  };
  return { judge, doJudge };
}

const GAUNTLET_PASS = {
  paraphrase: 'pass',
  polarity: 'pass',
  injection: 'pass',
  master_key: 'pass',
  label_permutation: 'pass',
  constant_output: 'pass',
  position_swap: 'pass',
  length: 'pass',
} as const;

function lockCriterion(over: Partial<LockCriterion> = {}): LockCriterion {
  return {
    wordingHash: 'x',
    status: 'calibrated',
    threshold: 0.5,
    tolerance: 0,
    gauntlet: GAUNTLET_PASS,
    reasons: [],
    labelCount: 60,
    ...over,
  };
}

function lockOf(criteria: Record<string, LockCriterion>, pinned = true): Lock {
  return {
    lockVersion: 1,
    model: { requested: 'fake/jev', resolved: 'fake/jev-1', transport: 'fake-transport', pinned },
    criteria,
    datasetHash: 'd',
  };
}

function find(
  results: readonly RunVerdict[],
  caseId: string,
  criterionId: string,
): RunVerdict | undefined {
  return results.find((v) => v.caseId === caseId && v.criterionId === criterionId);
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------- runEvals: pass / fail / unscored ----------

describe('runEvals results and summary', () => {
  test('pass, fail and unscored cases are counted and exit 1', async () => {
    const paths = await suite(
      [BOOL_YAML],
      [
        { id: 'c-pass', input: { state: 'S-pass' } },
        { id: 'c-fail', input: { state: 'S-fail' } },
        { id: 'c-down', input: { state: 'S-down' } },
      ],
    );
    const { judge } = scriptedJudge({
      'S-pass': { 'answers-question': yes(0.9) },
      'S-fail': { 'answers-question': yes(0.2) },
      'S-down': 'throw',
    });
    const out = await runEvals({ config: { ...paths, judge } });

    expect(out.summary).toMatchObject({ total: 3, passed: 1, failed: 1, unscored: 1 });
    expect(out.exitCode).toBe(1);
    expect(find(out.results, 'c-pass', 'answers-question')?.pass).toBe(true);
    expect(find(out.results, 'c-fail', 'answers-question')?.pass).toBe(false);
    expect(find(out.results, 'c-down', 'answers-question')?.status).toBe('unscored');
    expect(out.model).toMatchObject({ requested: 'fake/jev', transport: 'fake-transport' });
  });

  test('default threshold is 0.5 and marked uncalibrated when no lock exists', async () => {
    const paths = await suite([BOOL_YAML], [{ id: 'c1', input: { state: 'S1' } }]);
    const { judge } = scriptedJudge({ S1: { 'answers-question': yes(0.9) } });
    const out = await runEvals({ config: { ...paths, judge } });

    const v = find(out.results, 'c1', 'answers-question');
    expect(v?.threshold).toBe(0.5);
    expect(v?.calibrated).toBe(false);
    expect(out.exitCode).toBe(0);
  });

  test('every runEvals verdict validates against the published verdictSchema', async () => {
    const paths = await suite([BOOL_YAML], [{ id: 'c1', input: { state: 'S1' } }]);
    const { judge } = scriptedJudge({ S1: { 'answers-question': yes(0.9) } });
    const out = await runEvals({ config: { ...paths, judge } });

    expect(out.results).toHaveLength(1);
    for (const v of out.results) {
      expect(v).toHaveProperty('borderline');
      expect(v).toHaveProperty('calibrated');
      const r = validateJson(v, verdictSchema);
      expect(r.ok ? [] : r.error.cause).toEqual([]);
    }
  });

  test('pass_when_false polarity passes a low probability', async () => {
    const paths = await suite([NEG_YAML], [{ id: 'c1', input: { state: 'S1' } }]);
    const { judge } = scriptedJudge({ S1: { 'is-rude': yes(0.1) } });
    const out = await runEvals({ config: { ...paths, judge } });

    expect(find(out.results, 'c1', 'is-rude')?.pass).toBe(true);
    expect(out.exitCode).toBe(0);
  });

  test('choice passes when the chosen label is in passWhen', async () => {
    const paths = await suite(
      [CHOICE_YAML],
      [
        { id: 'c-polite', input: { state: 'S-polite' } },
        { id: 'c-rude', input: { state: 'S-rude' } },
      ],
    );
    const { judge } = scriptedJudge({
      'S-polite': { tone: tone('polite') },
      'S-rude': { tone: tone('rude') },
    });
    const out = await runEvals({ config: { ...paths, judge } });

    expect(find(out.results, 'c-polite', 'tone')?.pass).toBe(true);
    expect(find(out.results, 'c-rude', 'tone')?.pass).toBe(false);
    expect(out.exitCode).toBe(1);
  });

  test('P(escape) at or above escapeThreshold gives not_applicable and does not fail', async () => {
    const paths = await suite([BOOL_YAML], [{ id: 'c1', input: { state: 'S1' } }]);
    const { judge } = scriptedJudge({ S1: { 'answers-question': escaped() } });
    const out = await runEvals({ config: { ...paths, judge } });

    expect(find(out.results, 'c1', 'answers-question')?.status).toBe('not_applicable');
    expect(out.exitCode).toBe(0);
  });

  test('zero cases: total 0, exit 0 and a NO_CASES diag', async () => {
    const paths = await suite([BOOL_YAML], []);
    const { judge } = scriptedJudge({});
    const { events, names } = collect();
    const out = await runEvals({ config: { ...paths, judge }, events });

    expect(out.summary.total).toBe(0);
    expect(out.exitCode).toBe(0);
    expect(names).toContain('diag:NO_CASES');
  });

  test('all unscored exits 1', async () => {
    const paths = await suite([BOOL_YAML], [{ id: 'c1', input: { state: 'S1' } }]);
    const { judge } = scriptedJudge({ S1: 'throw' });
    const out = await runEvals({ config: { ...paths, judge } });

    expect(out.summary).toMatchObject({ total: 1, passed: 0, failed: 0, unscored: 1 });
    expect(out.exitCode).toBe(1);
  });

  test('an invalid criteria file throws a VetError', async () => {
    const paths = await suite([], []);
    const { judge } = scriptedJudge({});
    await expect(runEvals({ config: { ...paths, judge } })).rejects.toSatisfy((e) =>
      VetError.isInstance(e),
    );
  });
});

// ---------- tolerance band ----------

function mk(id: string): Case {
  return { id, input: { state: id }, provenance: {}, tags: [] };
}

describe('borderline tolerance band', () => {
  const criterion: Criterion = {
    id: 'answers-question',
    type: 'boolean',
    instructions: 'Q?',
    escape: 'empty',
    polarity: 'pass_when_true',
    channel: 'outcome',
    provenance: { traceIds: [] },
    wordingHash: 'h',
  };

  test('flags borderline at exactly threshold±tolerance and still decides by sign', async () => {
    const { judge } = scriptedJudge({
      hi: { 'answers-question': yes(0.65) },
      lo: { 'answers-question': yes(0.55) },
      far: { 'answers-question': yes(0.9) },
    });
    const lock = lockOf({ 'answers-question': lockCriterion({ threshold: 0.6, tolerance: 0.05 }) });
    const verdicts = await runJudge({
      cases: [mk('hi'), mk('lo'), mk('far')],
      criteria: [criterion],
      judge,
      lock,
    });

    expect(find(verdicts, 'hi', 'answers-question')).toMatchObject({
      borderline: true,
      pass: true,
      threshold: 0.6,
    });
    expect(find(verdicts, 'lo', 'answers-question')).toMatchObject({
      borderline: true,
      pass: false,
    });
    expect(find(verdicts, 'far', 'answers-question')).toMatchObject({
      borderline: false,
      pass: true,
    });
    expect(find(verdicts, 'far', 'answers-question')?.calibrated).toBe(true);
  });
});

// ---------- gate ----------

describe('gate policy (exit 2)', () => {
  test('gate with no lock refuses with exit 2 and a reason naming the lock', async () => {
    const paths = await suite([BOOL_YAML], [{ id: 'c1', input: { state: 'S1' } }]);
    const { judge } = scriptedJudge({ S1: { 'answers-question': yes(0.9) } });
    const out = await runEvals({ config: { ...paths, judge, gate: true } });

    expect(out.exitCode).toBe(2);
    expect(out.gateReasons.join('\n')).toMatch(/lock/i);
  });

  test('gate refuses when a gated boolean or choice criterion is uncalibrated, naming it', async () => {
    const paths = await suite([BOOL_YAML, CHOICE_YAML], [{ id: 'c1', input: { state: 'S1' } }]);
    const { judge } = scriptedJudge({ S1: { 'answers-question': yes(0.9), tone: tone('polite') } });
    const lock = lockOf({
      'answers-question': lockCriterion(),
      tone: lockCriterion({ status: 'uncalibrated' }),
    });
    const out = await runEvals({ config: { ...paths, judge, gate: true }, lock });

    expect(out.exitCode).toBe(2);
    expect(out.gateReasons.join('\n')).toContain('tone');
    expect(out.gateReasons.join('\n')).not.toContain('answers-question');
  });

  test('gate refuses an unpinned transport without allowUnpinned, naming the transport', async () => {
    const paths = await suite([BOOL_YAML], [{ id: 'c1', input: { state: 'S1' } }]);
    const { judge } = scriptedJudge(
      { S1: { 'answers-question': yes(0.9) } },
      { pinned: false, transport: 'alias-gateway' },
    );
    const lock = lockOf({ 'answers-question': lockCriterion() }, false);
    const out = await runEvals({ config: { ...paths, judge, gate: true }, lock });

    expect(out.exitCode).toBe(2);
    expect(out.gateReasons.join('\n')).toContain('alias-gateway');
  });

  test('gate with allowUnpinned and a calibrated lock exits by results', async () => {
    const paths = await suite(
      [BOOL_YAML],
      [
        { id: 'c1', input: { state: 'S1' } },
        { id: 'c2', input: { state: 'S2' } },
      ],
    );
    const lock = lockOf({ 'answers-question': lockCriterion() }, false);
    const passing = scriptedJudge(
      { S1: { 'answers-question': yes(0.9) }, S2: { 'answers-question': yes(0.8) } },
      { pinned: false },
    );
    const ok = await runEvals({
      config: { ...paths, judge: passing.judge, gate: true, gatePolicy: { allowUnpinned: true } },
      lock,
    });
    expect(ok.exitCode).toBe(0);

    const failing = scriptedJudge(
      { S1: { 'answers-question': yes(0.9) }, S2: { 'answers-question': yes(0.1) } },
      { pinned: false },
    );
    const bad = await runEvals({
      config: { ...paths, judge: failing.judge, gate: true, gatePolicy: { allowUnpinned: true } },
      lock,
    });
    expect(bad.exitCode).toBe(1);
  });

  test('evaluateGate with no lock returns exit 2 and reasons', () => {
    const result = evaluateGate({
      verdicts: [],
      lock: null,
      policy: { requireCalibrated: true, allowUnpinned: false },
    });
    expect(result.exitCode).toBe(2);
    expect(result.reasons.length).toBeGreaterThan(0);
  });
});

// ---------- events ----------

describe('events', () => {
  test('emits run:start, case:start per case and run:end, never writing stdout', async () => {
    const stdout = vi.spyOn(process.stdout, 'write');
    const paths = await suite(
      [BOOL_YAML],
      [
        { id: 'c1', input: { state: 'S1' } },
        { id: 'c2', input: { state: 'S2' } },
      ],
    );
    const { judge } = scriptedJudge({
      S1: { 'answers-question': yes(0.9) },
      S2: { 'answers-question': yes(0.9) },
    });
    const { events, names } = collect();
    await runEvals({ config: { ...paths, judge }, events });

    expect(names[0]).toBe('run:start');
    expect(names.at(-1)).toBe('run:end');
    expect(names.filter((t) => t === 'case:start')).toHaveLength(2);
    expect(stdout).not.toHaveBeenCalled();
  });
});

describe('event bus', () => {
  type Seen = { name: keyof EventMap; payload: EventMap[keyof EventMap] };
  const NAMES = [
    'run:start',
    'case:start',
    'judge:request',
    'judge:response',
    'verdict',
    'run:end',
  ] as const;
  const CONTENT_KEYS = ['state', 'prompt', 'answer', 'answers', 'instructions', 'content', 'text'];

  interface Recorded {
    events: ReturnType<typeof createEvents>;
    seen: Seen[];
    responses: EventMap['judge:response'][];
  }
  function record(): Recorded {
    const events = createEvents();
    const seen: Seen[] = [];
    const responses: EventMap['judge:response'][] = [];
    for (const name of NAMES) events.on(name, (payload) => seen.push({ name, payload }));
    events.on('judge:response', (payload) => responses.push(payload));
    return { events, seen, responses };
  }
  const count = (seen: Seen[], name: keyof EventMap): number =>
    seen.filter((e) => e.name === name).length;

  test('runEvals emits the EventMap events on an injected Events, with no content keys', async () => {
    const paths = await suite(
      [BOOL_YAML],
      [
        { id: 'c1', input: { state: 'PRIVATE-STATE-ONE' } },
        { id: 'c2', input: { state: 'PRIVATE-STATE-TWO' } },
      ],
    );
    const { judge } = scriptedJudge({
      'PRIVATE-STATE-ONE': { 'answers-question': yes(0.9) },
      'PRIVATE-STATE-TWO': { 'answers-question': yes(0.9) },
    });
    const cacheDir = await mkdtemp(join(tmpdir(), 'vetkit-run-cache-'));
    const first = record();
    await runEvals({ config: { ...paths, judge, cacheDir }, events: first.events });

    expect(count(first.seen, 'run:start')).toBe(1);
    expect(count(first.seen, 'case:start')).toBe(2);
    expect(count(first.seen, 'judge:request')).toBe(2);
    expect(count(first.seen, 'judge:response')).toBe(2);
    expect(count(first.seen, 'verdict')).toBe(2);
    expect(count(first.seen, 'run:end')).toBe(1);
    expect(first.seen[0]?.name).toBe('run:start');
    expect(first.seen.at(-1)?.name).toBe('run:end');
    for (const r of first.responses) {
      expect(r.status).toEqual(expect.any(Number));
      expect(r.durationMs).toEqual(expect.any(Number));
      expect(r.cacheHit).toBe(false);
    }
    for (const { payload } of first.seen) {
      for (const key of CONTENT_KEYS) expect(payload).not.toHaveProperty(key);
      expect(JSON.stringify(payload)).not.toContain('PRIVATE-STATE');
    }

    const rerun = record();
    await runEvals({ config: { ...paths, judge, cacheDir }, events: rerun.events });
    const cached = rerun.responses;
    expect(cached).toHaveLength(2);
    for (const r of cached) expect(r.cacheHit).toBe(true);
  });

  test('a transport HTTP error rides the real status on judge:response and status/errorType (never body or key) on verdict', async () => {
    const apiKey = 'sk-test-do-not-log-3d81';
    const failing: JudgeV1 = {
      specVersion: 'v1',
      id: 'fake',
      capabilities: {
        questionTypes: ['boolean', 'choice', 'score'],
        maxStateTokens: 32_000,
        pinned: true,
        transport: 'fake-transport',
        model: 'fake/jev',
      },
      doJudge: () =>
        Promise.reject(
          new VetError(
            CEV_ERROR_CODES.JUDGE_UNAVAILABLE,
            'judge unavailable (HTTP 403: no_providers_available)',
            {
              cause: {
                status: 403,
                body: { error: { type: 'no_providers_available' }, secretEcho: apiKey },
              },
              details: { retryable: false, hint: 'no_providers_available' },
            },
          ),
        ),
    };
    const events = createEvents();
    const responses: EventMap['judge:response'][] = [];
    const verdicts: EventMap['verdict'][] = [];
    events.on('judge:response', (p) => responses.push(p));
    events.on('verdict', (p) => verdicts.push(p));
    const criterion: Criterion = {
      id: 'answers-question',
      type: 'boolean',
      instructions: 'Q?',
      escape: 'empty',
      polarity: 'pass_when_true',
      channel: 'outcome',
      provenance: { traceIds: [] },
      wordingHash: 'h',
    };

    await runJudge({ cases: [mk('c1')], criteria: [criterion], judge: failing, events });

    expect(responses).toHaveLength(1);
    expect(responses[0]?.status).toBe(403);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]?.status).toBe('unscored');
    expect(verdicts[0]?.cause).toEqual({ status: 403, errorType: 'no_providers_available' });
    const text = JSON.stringify(verdicts[0]);
    expect(text).not.toContain('secretEcho');
    expect(text).not.toContain(apiKey);
    expect(text).not.toContain('body');
  });
});

// ---------- limiter and abort ----------

function countingLimiter(): { limiter: Limiter; runs: () => number } {
  let count = 0;
  let chain: Promise<unknown> = Promise.resolve();
  const limiter: Limiter = {
    run<T>(fn: () => Promise<T>, options?: { readonly signal?: AbortSignal }): Promise<T> {
      const next = chain.then(() => {
        if (options?.signal?.aborted === true) throw options.signal.reason;
        count += 1;
        return fn();
      });
      chain = next.catch(() => undefined);
      return next;
    },
    stats: () => ({ inFlight: 0, ceiling: 1, queued: 0, pausedUntil: 0, retries: 0, throttles: 0 }),
  };
  return { limiter, runs: () => count };
}

describe('limiter and abort', () => {
  test('every judge call goes through the injected limiter', async () => {
    const paths = await suite(
      [BOOL_YAML],
      [
        { id: 'c1', input: { state: 'S1' } },
        { id: 'c2', input: { state: 'S2' } },
        { id: 'c3', input: { state: 'S3' } },
      ],
    );
    const { judge, doJudge } = scriptedJudge({
      S1: { 'answers-question': yes(0.9) },
      S2: { 'answers-question': yes(0.9) },
      S3: { 'answers-question': yes(0.9) },
    });
    const { limiter, runs } = countingLimiter();
    await runEvals({ config: { ...paths, judge }, limiter });

    expect(doJudge).toHaveBeenCalledTimes(3);
    expect(runs()).toBe(3);
  });

  test('an aborted run returns exit 130, summary.aborted and remaining cases unscored', async () => {
    const paths = await suite(
      [BOOL_YAML],
      [
        { id: 'c1', input: { state: 'S1' } },
        { id: 'c2', input: { state: 'S2' } },
        { id: 'c3', input: { state: 'S3' } },
      ],
    );
    const controller = new AbortController();
    const { judge, doJudge } = scriptedJudge(
      {
        S1: { 'answers-question': yes(0.9) },
        S2: { 'answers-question': yes(0.9) },
        S3: { 'answers-question': yes(0.9) },
      },
      { onCall: () => controller.abort() },
    );
    const { limiter } = countingLimiter();
    const out = await runEvals({ config: { ...paths, judge }, limiter, signal: controller.signal });

    expect(doJudge).toHaveBeenCalledTimes(1);
    expect(out.exitCode).toBe(130);
    expect(out.summary.aborted).toBe(true);
    const unscored = out.results.filter((v) => v.status === 'unscored');
    expect(unscored).toHaveLength(2);
    expect(unscored.every((v) => v.cause === 'aborted')).toBe(true);
  });
});

// ---------- gate eligibility ----------

describe('gate eligibility', () => {
  test('a failing score criterion never affects exit; its verdict is gated:false score_not_gateable', async () => {
    const paths = await suite([BOOL_YAML, SCORE_YAML], [{ id: 'c1', input: { state: 'S1' } }]);
    const { judge } = scriptedJudge({
      S1: { 'answers-question': yes(0.9), helpfulness: score(0.1) },
    });

    const plain = await runEvals({ config: { ...paths, judge } });
    const s = find(plain.results, 'c1', 'helpfulness');
    expect(s?.pass).toBe(false);
    expect(s).toMatchObject({ gated: false, gateReason: 'score_not_gateable' });
    expect(plain.exitCode).toBe(0);

    const lock = lockOf({
      'answers-question': lockCriterion(),
      helpfulness: lockCriterion({ status: 'uncalibrated' }),
    });
    const gated = await runEvals({ config: { ...paths, judge, gate: true }, lock });
    expect(gated.exitCode).toBe(0);
  });

  test('a score-only suite emits a NO_GATEABLE_CRITERIA diag', async () => {
    const paths = await suite([SCORE_YAML], [{ id: 'c1', input: { state: 'S1' } }]);
    const { judge } = scriptedJudge({ S1: { helpfulness: score(2) } });
    const { events, names } = collect();
    await runEvals({ config: { ...paths, judge }, events });

    expect(names).toContain('diag:NO_GATEABLE_CRITERIA');
  });

  test('a failing case in a language outside lock languages is not gated', async () => {
    const paths = await suite(
      [BOOL_YAML],
      [
        { id: 'c-en', input: { state: 'S-en' }, language: 'en' },
        { id: 'c-kk', input: { state: 'S-kk' }, language: 'kk' },
      ],
    );
    const { judge } = scriptedJudge({
      'S-en': { 'answers-question': yes(0.9) },
      'S-kk': { 'answers-question': yes(0.1) },
    });
    const lock = lockOf({ 'answers-question': lockCriterion({ languages: ['en'] }) });
    const out = await runEvals({ config: { ...paths, judge, gate: true }, lock });

    expect(find(out.results, 'c-kk', 'answers-question')).toMatchObject({
      pass: false,
      gated: false,
      gateReason: 'language_not_calibrated',
    });
    expect(out.exitCode).toBe(0);
  });

  test('a case with no language is treated as und', async () => {
    const paths = await suite([BOOL_YAML], [{ id: 'c1', input: { state: 'S1' } }]);
    const { judge } = scriptedJudge({ S1: { 'answers-question': yes(0.1) } });
    const lock = lockOf({ 'answers-question': lockCriterion({ languages: ['und'] }) });
    const out = await runEvals({ config: { ...paths, judge }, lock });

    expect(find(out.results, 'c1', 'answers-question')?.gated).toBe(true);
    expect(out.exitCode).toBe(1);
  });

  test('a lock entry with languages: [] gates like no calibrated entry, not like an out-of-language case', async () => {
    const paths = await suite([BOOL_YAML], [{ id: 'c1', input: { state: 'S1' } }]);
    const { judge } = scriptedJudge({ S1: 'throw' });
    const lock = lockOf({ 'answers-question': lockCriterion({ languages: [] }) });
    const out = await runEvals({ config: { ...paths, judge }, lock });

    expect(find(out.results, 'c1', 'answers-question')).toMatchObject({ gated: true });
    expect(out.exitCode).toBe(1);
  });
});

// ---------- code graders ----------

describe('code-graded criteria', () => {
  test('are graded without any judge call: pass, fail and missing expected', async () => {
    const paths = await suite(
      [CODE_YAML],
      [
        {
          id: 'c-pass',
          input: { state: 'S', answer: 'The sum is 42' },
          expected: { value: 42, source: 'user' },
        },
        {
          id: 'c-fail',
          input: { state: 'S', answer: 'The sum is 41' },
          expected: { value: 42, source: 'user' },
        },
        { id: 'c-noexp', input: { state: 'S', answer: '42' } },
      ],
    );
    const { judge, doJudge } = scriptedJudge({});
    const out = await runEvals({ config: { ...paths, judge } });

    expect(doJudge).not.toHaveBeenCalled();
    expect(find(out.results, 'c-pass', 'sum-correct')).toMatchObject({
      status: 'ok',
      pass: true,
      answer: { type: 'boolean', probability: 1 },
    });
    expect(find(out.results, 'c-fail', 'sum-correct')).toMatchObject({
      status: 'ok',
      pass: false,
      answer: { type: 'boolean', probability: 0 },
    });
    expect(find(out.results, 'c-noexp', 'sum-correct')).toMatchObject({
      status: 'not_applicable',
      cause: 'reference_missing',
    });
  });

  test('a missing answer gives not_applicable answer_missing', async () => {
    const paths = await suite(
      [CODE_YAML],
      [{ id: 'c1', input: { state: 'S' }, expected: { value: 42, source: 'user' } }],
    );
    const { judge } = scriptedJudge({});
    const out = await runEvals({ config: { ...paths, judge } });

    expect(find(out.results, 'c1', 'sum-correct')).toMatchObject({
      status: 'not_applicable',
      cause: 'answer_missing',
    });
  });

  test('a code-graded criterion is left out of the judge request', async () => {
    const paths = await suite(
      [BOOL_YAML, CODE_YAML],
      [{ id: 'c1', input: { state: 'S1', answer: '42' }, expected: { value: 42, source: 'user' } }],
    );
    const { judge, doJudge } = scriptedJudge({ S1: { 'answers-question': yes(0.9) } });
    await runEvals({ config: { ...paths, judge } });

    expect(doJudge).toHaveBeenCalledTimes(1);
    expect(Object.keys(doJudge.mock.calls[0]?.[0].questions ?? {})).toEqual(['answers-question']);
  });
});

// ---------- saturation ----------

describe('byCriterion saturation', () => {
  test('flags all_pass and all_fail, emits CRITERION_SATURATED diags, and leaves mixed as null', async () => {
    const paths = await suite(
      [BOOL_YAML, NEG_YAML, CHOICE_YAML],
      [
        { id: 'c1', input: { state: 'S1' } },
        { id: 'c2', input: { state: 'S2' } },
      ],
    );
    const { judge } = scriptedJudge({
      S1: { 'answers-question': yes(0.9), 'is-rude': yes(0.9), tone: tone('polite') },
      S2: { 'answers-question': yes(0.9), 'is-rude': yes(0.9), tone: tone('rude') },
    });
    const { events, names } = collect();
    const out = await runEvals({ config: { ...paths, judge }, events });

    expect(out.summary.byCriterion['answers-question']).toEqual({
      total: 2,
      passed: 2,
      failed: 0,
      unscored: 0,
      saturated: 'all_pass',
    });
    expect(out.summary.byCriterion['is-rude']?.saturated).toBe('all_fail');
    expect(out.summary.byCriterion['tone']?.saturated).toBeNull();
    const saturated = names.filter((n) => n === 'diag:CRITERION_SATURATED');
    expect(saturated).toHaveLength(2);
    expect(out.exitCode).toBe(1);
  });
});

// ---------- verdict provenance ----------

describe('verdict provenance', () => {
  const TRACE = '0af7651916cd43dd8448eb211c80319c';

  test('provenance picks the six keys from case.provenance and case.traceId', async () => {
    const paths = await suite(
      [BOOL_YAML],
      [
        {
          id: 'c1',
          input: { state: 'S1' },
          traceId: TRACE,
          provenance: {
            traceId: 'overridden',
            spanId: 'b7ad6b7169203331',
            responseId: 'resp-1',
            observationId: 'obs-1',
            dialect: 'openinference',
            schemaUrl: 'https://example.test/schema',
            extra: 'dropped',
            source: { nested: true },
            count: 3,
          },
        },
      ],
    );
    const { judge } = scriptedJudge({ S1: { 'answers-question': yes(0.9) } });
    const out = await runEvals({ config: { ...paths, judge } });
    const v = find(out.results, 'c1', 'answers-question');
    expect(v?.provenance).toEqual({
      traceId: TRACE,
      spanId: 'b7ad6b7169203331',
      responseId: 'resp-1',
      observationId: 'obs-1',
      dialect: 'openinference',
      schemaUrl: 'https://example.test/schema',
    });
    expect(validateJson(v, verdictSchema).ok).toBe(true);
  });

  test('unscored verdict carries provenance', async () => {
    const paths = await suite(
      [BOOL_YAML],
      [{ id: 'c1', input: { state: 'S1' }, traceId: TRACE, provenance: { spanId: 's1' } }],
    );
    const { judge } = scriptedJudge({ S1: 'throw' });
    const out = await runEvals({ config: { ...paths, judge } });
    const v = find(out.results, 'c1', 'answers-question');
    expect(v?.status).toBe('unscored');
    expect(v?.provenance).toEqual({ traceId: TRACE, spanId: 's1' });
  });

  test('null case.provenance yields no provenance', async () => {
    const paths = await suite(
      [BOOL_YAML],
      [{ id: 'c1', input: { state: 'S1' }, provenance: null }],
    );
    const { judge } = scriptedJudge({ S1: { 'answers-question': yes(0.9) } });
    const out = await runEvals({ config: { ...paths, judge } });
    const v = find(out.results, 'c1', 'answers-question');
    expect(v).toBeDefined();
    expect(v?.provenance).toBeUndefined();
  });
});

// ---------- pre-judge gate refusal ----------

describe('gate refusal before any judge call', () => {
  test('--gate with no lock refuses with 0 judge calls, naming criteria.lock.json', async () => {
    const paths = await suite([BOOL_YAML], [{ id: 'c1', input: { state: 'S1' } }]);
    const { judge, doJudge } = scriptedJudge({ S1: { 'answers-question': yes(0.9) } });
    const out = await runEvals({ config: { ...paths, judge, gate: true } });

    expect(doJudge).toHaveBeenCalledTimes(0);
    expect(out.exitCode).toBe(2);
    expect(out.results).toEqual([]);
    expect(out.gateReasons.join('\n')).toContain('criteria.lock.json');
  });

  test('--gate with an uncalibrated referenced criterion refuses with 0 calls: GATE_UNCALIBRATED names it', async () => {
    const paths = await suite([BOOL_YAML, CHOICE_YAML], [{ id: 'c1', input: { state: 'S1' } }]);
    const { judge, doJudge } = scriptedJudge({
      S1: { 'answers-question': yes(0.9), tone: tone('polite') },
    });
    const lock = lockOf({
      'answers-question': lockCriterion(),
      tone: lockCriterion({ status: 'uncalibrated' }),
    });
    const out = await runEvals({ config: { ...paths, judge, gate: true }, lock });

    expect(doJudge).toHaveBeenCalledTimes(0);
    expect(out.exitCode).toBe(2);
    expect(out.gateReasons.join('\n')).toContain('GATE_UNCALIBRATED');
    expect(out.gateReasons.join('\n')).toContain("'tone'");
  });

  test('--ci on a floating lock refuses with 0 calls: GATE_UNPINNED', async () => {
    const paths = await suite([BOOL_YAML], [{ id: 'c1', input: { state: 'S1' } }]);
    const { judge, doJudge } = scriptedJudge({ S1: { 'answers-question': yes(0.9) } });
    const lock = lockOf({ 'answers-question': lockCriterion({ status: 'floating' }) }, false);
    const out = await runEvals({ config: { ...paths, judge, ci: true }, lock });

    expect(doJudge).toHaveBeenCalledTimes(0);
    expect(out.exitCode).toBe(2);
    expect(out.gateReasons.join('\n')).toContain('GATE_UNPINNED');
  });

  test('--gate with no lock refuses: summary passed/failed are 0, matching empty results', async () => {
    const paths = await suite([BOOL_YAML], [{ id: 'c1', input: { state: 'S1' } }]);
    const { judge, doJudge } = scriptedJudge({ S1: { 'answers-question': yes(0.9) } });
    const out = await runEvals({ config: { ...paths, judge, gate: true } });

    expect(doJudge).toHaveBeenCalledTimes(0);
    expect(out.results).toEqual([]);
    expect(out.summary).toMatchObject({ passed: 0, failed: 0 });
    expect(out.gateReasons.join('\n')).toContain('criteria.lock.json');
  });

  test('--ci --allow-unpinned on a floating lock judges and exits by results', async () => {
    const paths = await suite([BOOL_YAML], [{ id: 'c1', input: { state: 'S1' } }]);
    const { judge, doJudge } = scriptedJudge(
      { S1: { 'answers-question': yes(0.9) } },
      { pinned: false },
    );
    const lock = lockOf({ 'answers-question': lockCriterion({ status: 'floating' }) }, false);
    const out = await runEvals({
      config: { ...paths, judge, ci: true, gatePolicy: { allowUnpinned: true } },
      lock,
    });

    expect(doJudge).toHaveBeenCalledTimes(1);
    expect(out.exitCode).toBe(0);
  });

  test('--gate --allow-unpinned accepts floating entries and exits by results', async () => {
    const paths = await suite([BOOL_YAML], [{ id: 'c1', input: { state: 'S1' } }]);
    const lock = lockOf({ 'answers-question': lockCriterion({ status: 'floating' }) }, false);
    const passing = scriptedJudge({ S1: { 'answers-question': yes(0.9) } }, { pinned: false });
    const ok = await runEvals({
      config: { ...paths, judge: passing.judge, gate: true, gatePolicy: { allowUnpinned: true } },
      lock,
    });
    expect(ok.exitCode).toBe(0);
    expect(ok.gateReasons).toEqual([]);

    const failing = scriptedJudge({ S1: { 'answers-question': yes(0.1) } }, { pinned: false });
    const bad = await runEvals({
      config: { ...paths, judge: failing.judge, gate: true, gatePolicy: { allowUnpinned: true } },
      lock,
    });
    expect(bad.exitCode).toBe(1);
  });

  test('a score criterion uncalibrated in the lock does not block the pre-judge gate', async () => {
    const paths = await suite([BOOL_YAML, SCORE_YAML], [{ id: 'c1', input: { state: 'S1' } }]);
    const { judge, doJudge } = scriptedJudge({
      S1: { 'answers-question': yes(0.9), helpfulness: score(0.1) },
    });
    const lock = lockOf({ 'answers-question': lockCriterion() });
    const out = await runEvals({ config: { ...paths, judge, gate: true }, lock });

    expect(doJudge).toHaveBeenCalledTimes(1);
    expect(out.exitCode).toBe(0);
  });
});

// ---------- one threshold scale across calibrate, lock and run ----------

describe('pass_when_false threshold scale: calibrate → lock → runEvals', () => {
  test('a pass_when_false criterion calibrated at t ≠ 0.5 passes exactly the cases on the pass side of t', async () => {
    // Not rude (label pass): P(yes) 0.1 → pass value 0.9. Rude (label fail): P(yes) 0.5 → pass
    // value 0.5. Any t in (0.5, 0.9] separates them, so the fitted t sits well above 0.5.
    const cases: CaseLine[] = [];
    const labels: CalibrationLabel[] = [];
    const script: Script = {};
    const repeats = new Map<string, JudgeResponse[]>();
    for (let i = 0; i < 120; i += 1) {
      const pass = i % 2 === 0;
      const id = `c${String(i)}`;
      const state = `S${String(i)}`;
      const answer = yes(pass ? 0.1 : 0.5);
      cases.push({ id, input: { state } });
      labels.push({ caseId: id, label: pass ? 'pass' : 'fail' });
      script[state] = { 'is-rude': answer };
      const response: JudgeResponse = {
        answers: { 'is-rude': answer },
        usage: { inputTokens: 1, outputTokens: 0 },
        model: { requested: 'fake/jev', resolved: 'fake/jev-1', transport: 'fake', pinned: true },
      };
      repeats.set(id, [response, response, response]);
    }
    const paths = await suite([NEG_YAML], cases);
    const loaded = await loadCriteria(paths.criteriaPath);
    if (!loaded.ok) throw new Error('criteria did not load');
    const criterion = loaded.criteria[0];
    if (criterion === undefined) throw new Error('no criterion');
    const fullCases = cases.map((c) => ({ provenance: {}, tags: [], ...c }));

    const calibration = calibrate(criterion, labels, repeats, fullCases);
    const t = calibration.threshold;
    expect(t).toBeDefined();
    expect(Math.abs((t ?? 0.5) - 0.5)).toBeGreaterThan(0.1);
    expect(calibration.tpr).toBe(1);
    expect(calibration.tnr).toBe(1);

    const lockPath = join(await mkdtemp(join(tmpdir(), 'vetkit-lock-')), 'criteria.lock.json');
    const built = buildLock({
      model: { requested: 'fake/jev', resolved: 'fake/jev-1', transport: 'fake', pinned: true },
      criteria: [criterion],
      cases: fullCases,
      results: { 'is-rude': { calibration, gauntlet: GAUNTLET_PASS } },
    });
    await writeLockAtomic(lockPath, built);
    const lock = await readLock(lockPath);
    if ('error' in lock) throw lock.error;
    expect(lock.criteria['is-rude']?.threshold).toBe(t);

    const { judge } = scriptedJudge(script);
    const out = await runEvals({ config: { ...paths, judge }, lock });

    for (const { caseId, label } of labels) {
      const v = find(out.results, caseId, 'is-rude');
      expect(v?.threshold).toBe(t);
      expect({ caseId, pass: v?.pass }).toEqual({ caseId, pass: label === 'pass' });
    }
  });
});

// ---------- score threshold scale: expected level E, max − E for pass_when_false ----------

const NEG_SCORE_YAML = `  - id: harm
    type: score
    instructions: How harmful is the reply?
    criteria: [harmless, somewhat harmful, very harmful]
    polarity: pass_when_false
    channel: safety
    provenance: { traceIds: [] }
`;

function levels(argmax: number, probabilities: Record<string, number>): Answer {
  return { type: 'score', score: argmax, confidence: 0.5, legend: {}, probabilities };
}

describe('score threshold scale matches calibrate repeatValues', () => {
  test('a pass_when_false score criterion passes when max − E clears the lock threshold', async () => {
    // Levels 0..2, so max = 2. Low harm: E = 0.3 → pass value 1.7. High harm: E = 1.7 → 0.3.
    const paths = await suite(
      [NEG_SCORE_YAML],
      [
        { id: 'c-low', input: { state: 'S-low' } },
        { id: 'c-high', input: { state: 'S-high' } },
      ],
    );
    const { judge } = scriptedJudge({
      'S-low': { harm: levels(0, { '0': 0.8, '1': 0.1, '2': 0.1 }) },
      'S-high': { harm: levels(2, { '0': 0.1, '1': 0.1, '2': 0.8 }) },
    });
    const lock = lockOf({ harm: lockCriterion({ status: 'uncalibrated', threshold: 1 }) });
    const out = await runEvals({ config: { ...paths, judge }, lock });

    expect(find(out.results, 'c-low', 'harm')).toMatchObject({ threshold: 1, pass: true });
    expect(find(out.results, 'c-high', 'harm')).toMatchObject({ threshold: 1, pass: false });
  });

  test('a pass_when_true score criterion compares the expected level E, not the argmax score', async () => {
    // argmax 2 but E = 0·0.5 + 2·0.5 = 1, below the 1.5 threshold.
    const paths = await suite([SCORE_YAML], [{ id: 'c1', input: { state: 'S1' } }]);
    const { judge } = scriptedJudge({
      S1: { helpfulness: levels(2, { '0': 0.5, '1': 0, '2': 0.5 }) },
    });
    const lock = lockOf({ helpfulness: lockCriterion({ status: 'uncalibrated', threshold: 1.5 }) });
    const out = await runEvals({ config: { ...paths, judge }, lock });

    expect(find(out.results, 'c1', 'helpfulness')).toMatchObject({ threshold: 1.5, pass: false });
  });
});

// ---------- choice threshold scale: P(passWhen), 1 − P(passWhen) for pass_when_false ----------

const TONE3_YAML = `  - id: tone3
    type: choice
    instructions: Which tone does the reply take?
    criteria:
      polite: The reply is courteous.
      curt: The reply is short but not insulting.
      rude: The reply is insulting.
    passWhen: [polite]
    escape: The reply has no tone.
    polarity: pass_when_true
    channel: quality
    provenance: { traceIds: [] }
`;

function picked(choice: string, probabilities: Record<string, number>): Answer {
  return { type: 'choice', choice, confidence: 0.5, probabilities };
}

describe('choice threshold scale matches calibrate repeatValues (DECISION 2026-09-28)', () => {
  test('spread mass: argmax in passWhen but P(passWhen) below the threshold fails', async () => {
    const paths = await suite([TONE3_YAML], [{ id: 'c1', input: { state: 'S1' } }]);
    const { judge } = scriptedJudge({
      S1: { tone3: picked('polite', { polite: 0.4, curt: 0.3, rude: 0.3, escape: 0 }) },
    });
    const out = await runEvals({ config: { ...paths, judge } });

    expect(find(out.results, 'c1', 'tone3')).toMatchObject({ threshold: 0.5, pass: false });
  });

  test('a lock threshold ≠ 0.5 is applied to P(passWhen), not to the argmax label', async () => {
    const paths = await suite(
      [TONE3_YAML],
      [
        { id: 'c-low', input: { state: 'S-low' } },
        { id: 'c-lower', input: { state: 'S-lower' } },
      ],
    );
    const { judge } = scriptedJudge({
      // argmax rude, but P(polite) 0.35 clears 0.3.
      'S-low': { tone3: picked('rude', { polite: 0.35, curt: 0.05, rude: 0.6, escape: 0 }) },
      'S-lower': { tone3: picked('rude', { polite: 0.2, curt: 0.1, rude: 0.7, escape: 0 }) },
    });
    const lock = lockOf({ tone3: lockCriterion({ status: 'uncalibrated', threshold: 0.3 }) });
    const out = await runEvals({ config: { ...paths, judge }, lock });

    expect(find(out.results, 'c-low', 'tone3')).toMatchObject({ threshold: 0.3, pass: true });
    expect(find(out.results, 'c-lower', 'tone3')).toMatchObject({ threshold: 0.3, pass: false });
  });

  test('borderline is judged on P(passWhen) against the lock tolerance', async () => {
    const paths = await suite([TONE3_YAML], [{ id: 'c1', input: { state: 'S1' } }]);
    const { judge } = scriptedJudge({
      S1: { tone3: picked('polite', { polite: 0.62, curt: 0.2, rude: 0.18, escape: 0 }) },
    });
    const lock = lockOf({
      tone3: lockCriterion({ status: 'uncalibrated', threshold: 0.6, tolerance: 0.05 }),
    });
    const out = await runEvals({ config: { ...paths, judge }, lock });

    expect(find(out.results, 'c1', 'tone3')).toMatchObject({ pass: true, borderline: true });
  });

  test('pass_when_false choice compares 1 − P(passWhen) to the threshold', async () => {
    const yaml = TONE3_YAML.replace('pass_when_true', 'pass_when_false');
    const paths = await suite(
      [yaml],
      [
        { id: 'c-rare', input: { state: 'S-rare' } },
        { id: 'c-often', input: { state: 'S-often' } },
      ],
    );
    const { judge } = scriptedJudge({
      'S-rare': { tone3: picked('rude', { polite: 0.2, curt: 0.1, rude: 0.7, escape: 0 }) },
      'S-often': { tone3: picked('polite', { polite: 0.8, curt: 0.1, rude: 0.1, escape: 0 }) },
    });
    const out = await runEvals({ config: { ...paths, judge } });

    expect(find(out.results, 'c-rare', 'tone3')).toMatchObject({ threshold: 0.5, pass: true });
    expect(find(out.results, 'c-often', 'tone3')).toMatchObject({ threshold: 0.5, pass: false });
  });

  test('empty probabilities fall back to the argmax label in passWhen as 1 / 0', async () => {
    const paths = await suite(
      [TONE3_YAML],
      [
        { id: 'c-polite', input: { state: 'S-polite' } },
        { id: 'c-rude', input: { state: 'S-rude' } },
      ],
    );
    const { judge } = scriptedJudge({
      'S-polite': { tone3: picked('polite', {}) },
      'S-rude': { tone3: picked('rude', {}) },
    });
    const out = await runEvals({ config: { ...paths, judge } });

    expect(find(out.results, 'c-polite', 'tone3')).toMatchObject({ threshold: 0.5, pass: true });
    expect(find(out.results, 'c-rude', 'tone3')).toMatchObject({ threshold: 0.5, pass: false });
  });
});

// ---------- disabled criteria ----------

describe('disabled criteria (enabled: false)', () => {
  const DISABLED_YAML = NEG_YAML.replace(
    '    channel: safety\n',
    '    channel: safety\n    enabled: false\n',
  );

  test('are left out of the judge request and reported not_applicable with cause disabled', async () => {
    const paths = await suite([BOOL_YAML, DISABLED_YAML], [{ id: 'c1', input: { state: 'S1' } }]);
    const { judge, doJudge } = scriptedJudge({ S1: { 'answers-question': yes(0.9) } });
    const out = await runEvals({ config: { ...paths, judge } });

    expect(Object.keys(doJudge.mock.calls[0]?.[0].questions ?? {})).toEqual(['answers-question']);
    expect(find(out.results, 'c1', 'is-rude')).toMatchObject({
      status: 'not_applicable',
      cause: 'disabled',
    });
    expect(out.exitCode).toBe(0);
  });

  test('a disabled verdict validates against verdictSchema', async () => {
    const paths = await suite([BOOL_YAML, DISABLED_YAML], [{ id: 'c1', input: { state: 'S1' } }]);
    const { judge } = scriptedJudge({ S1: { 'answers-question': yes(0.9) } });
    const out = await runEvals({ config: { ...paths, judge } });

    const v = find(out.results, 'c1', 'is-rude');
    const r = validateJson(v, verdictSchema);
    expect(r.ok ? [] : r.error.cause).toEqual([]);
  });

  test('--gate does not demand calibration for a disabled criterion', async () => {
    const paths = await suite([BOOL_YAML, DISABLED_YAML], [{ id: 'c1', input: { state: 'S1' } }]);
    const { judge } = scriptedJudge({ S1: { 'answers-question': yes(0.9) } });
    const lock = lockOf({ 'answers-question': lockCriterion() });
    const out = await runEvals({ config: { ...paths, judge, gate: true }, lock });

    expect(out.gateReasons).toEqual([]);
    expect(out.exitCode).toBe(0);
  });
});
