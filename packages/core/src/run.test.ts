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
} from '@vetkit/spec';
import type { Limiter } from './judge/pacing.ts';
import { evaluateGate } from './gate.ts';
import { runEvals, runJudge, type RunConfig, type RunEvent, type RunVerdict } from './run.ts';

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

  test('zero cases: total 0, exit 0 and a run.no_cases event', async () => {
    const paths = await suite([BOOL_YAML], []);
    const { judge } = scriptedJudge({});
    const events: RunEvent[] = [];
    const out = await runEvals({ config: { ...paths, judge }, emit: (e) => events.push(e) });

    expect(out.summary.total).toBe(0);
    expect(out.exitCode).toBe(0);
    expect(events.map((e) => e.type)).toContain('run.no_cases');
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
  test('emits run.start, case.judged per case and run.end, never writing stdout', async () => {
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
    const events: RunEvent[] = [];
    await runEvals({ config: { ...paths, judge }, emit: (e) => events.push(e) });

    const types = events.map((e) => e.type);
    expect(types[0]).toBe('run.start');
    expect(types.at(-1)).toBe('run.end');
    expect(types.filter((t) => t === 'case.judged')).toHaveLength(2);
    expect(stdout).not.toHaveBeenCalled();
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

  test('a score-only suite emits gate.no_gateable_criteria', async () => {
    const paths = await suite([SCORE_YAML], [{ id: 'c1', input: { state: 'S1' } }]);
    const { judge } = scriptedJudge({ S1: { helpfulness: score(2) } });
    const events: RunEvent[] = [];
    await runEvals({ config: { ...paths, judge }, emit: (e) => events.push(e) });

    expect(events.map((e) => e.type)).toContain('gate.no_gateable_criteria');
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
  test('flags all_pass and all_fail, emits criterion.saturated, and leaves mixed as null', async () => {
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
    const events: RunEvent[] = [];
    const out = await runEvals({ config: { ...paths, judge }, emit: (e) => events.push(e) });

    expect(out.summary.byCriterion['answers-question']).toEqual({
      total: 2,
      passed: 2,
      failed: 0,
      unscored: 0,
      saturated: 'all_pass',
    });
    expect(out.summary.byCriterion['is-rude']?.saturated).toBe('all_fail');
    expect(out.summary.byCriterion['tone']?.saturated).toBeNull();
    const saturated = events.filter((e) => e.type === 'criterion.saturated');
    expect(saturated).toHaveLength(2);
    expect(out.exitCode).toBe(1);
  });
});
