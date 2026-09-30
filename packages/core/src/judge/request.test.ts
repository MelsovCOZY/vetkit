import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  CEV_ERROR_CODES,
  DEFAULT_REQUEST_FORMAT,
  validateJson,
  VetError,
  verdictSchema,
  type Answer,
  type CevErrorCode,
  type Case,
  type Criterion,
  type JudgeResponse,
  type JudgeV1,
  type Question,
} from '@vetkit/spec';
import { createFileCache, type VerdictCache } from './cache.ts';
import { renderState } from './format.ts';
import { createLimiter } from './pacing.ts';
import { buildRequest, cacheKey, judgeCase } from './request.ts';
import { runJudge } from '../run.ts';

type VetErrorDetails = NonNullable<VetError['details']>;

const SENTINEL = 'SENTINEL-OUTPUT-7f3a';

const booleanCriterion: Criterion = {
  id: 'answers-question',
  type: 'boolean',
  instructions: "Does the reply directly answer the user's question?",
  escape: 'The reply is empty or not in a readable language.',
  polarity: 'pass_when_true',
  channel: 'outcome',
  provenance: { traceIds: [] },
  wordingHash: 'hash-a',
};

const choiceCriterion: Criterion = {
  id: 'tone',
  type: 'choice',
  instructions: 'Which tone does the reply take?',
  criteria: {
    polite: 'The reply is courteous.',
    neutral: 'The reply is matter-of-fact.',
    rude: 'The reply is dismissive or insulting.',
  },
  passWhen: ['polite', 'neutral'],
  escape: 'The reply has no discernible tone.',
  polarity: 'pass_when_true',
  channel: 'quality',
  provenance: { traceIds: [] },
  wordingHash: 'hash-b',
};

const scoreCriterion: Criterion = {
  id: 'helpfulness',
  type: 'score',
  instructions: 'How helpful is the reply?',
  criteria: ['not helpful', 'somewhat helpful', 'very helpful'],
  polarity: 'pass_when_true',
  channel: 'quality',
  provenance: { traceIds: [] },
  wordingHash: 'hash-c',
};

const referenceCriterion: Criterion = {
  id: 'capital-correct',
  type: 'boolean',
  instructions: 'Does the reply name the correct capital city?',
  escape: 'The reply does not name any city.',
  polarity: 'pass_when_true',
  channel: 'outcome',
  provenance: { traceIds: [] },
  wordingHash: 'hash-d',
  checkable: 'factual',
  grader: { kind: 'reference' },
};

const criteria: Criterion[] = [booleanCriterion, choiceCriterion, scoreCriterion];

const evalCase: Case = {
  id: 'case-1',
  input: { state: `{"reply":"${SENTINEL}"}` },
  provenance: {},
  tags: [],
};

const referenceCase: Case = {
  ...evalCase,
  id: 'case-ref',
  expected: { value: 'Canberra', source: 'user' },
};

function answerFor(question: Question): Answer {
  if (question.type === 'choice') {
    const keys = Object.keys(question.criteria);
    const first = keys[0] ?? 'yes';
    return {
      type: 'choice',
      choice: first,
      confidence: 0.9,
      probabilities: Object.fromEntries(keys.map((k) => [k, k === first ? 0.9 : 0.05])),
    };
  }
  if (question.type === 'score') {
    return { type: 'score', score: 1.5, confidence: 0.5, legend: {}, probabilities: {} };
  }
  return { type: 'boolean', probability: 0.9 };
}

interface FakeJudge {
  readonly judge: JudgeV1;
  readonly doJudge: ReturnType<typeof vi.fn<JudgeV1['doJudge']>>;
}

function fakeJudge(
  opts: {
    id?: string;
    model?: string;
    resolved?: string;
    impl?: JudgeV1['doJudge'];
    drop?: string;
  } = {},
): FakeJudge {
  const defaultImpl: JudgeV1['doJudge'] = (req) => {
    const answers: Record<string, Answer> = {};
    for (const [key, question] of Object.entries(req.questions)) {
      if (key !== opts.drop) answers[key] = answerFor(question);
    }
    const response: JudgeResponse = {
      answers,
      usage: { inputTokens: 10, outputTokens: 0 },
      model: {
        requested: 'typesafe-ai/jev',
        resolved: opts.resolved ?? 'jev-1.13.0',
        transport: 'fake',
        pinned: false,
        credentialType: 'api-key',
      },
      raw: { secret: 'never-cached' },
    };
    return Promise.resolve(response);
  };
  const doJudge = vi.fn<JudgeV1['doJudge']>(opts.impl ?? defaultImpl);
  return {
    doJudge,
    judge: {
      specVersion: 'v1',
      id: opts.id ?? 'judge-fake',
      capabilities: {
        questionTypes: ['boolean', 'choice', 'score'],
        maxStateTokens: 32_000,
        pinned: false,
        transport: 'fake',
        model: opts.model ?? 'jev-fake-model',
      },
      doJudge,
    },
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vetkit-cache-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('buildRequest', () => {
  test('one request keyed by criterion id for N=3 criteria', () => {
    const req = buildRequest(evalCase, criteria);
    expect(Object.keys(req.questions)).toEqual(['answers-question', 'tone', 'helpfulness']);
  });

  test('boolean criterion compiles to a 3-way choice {yes, no, escape} with escape wording appended', () => {
    const q = buildRequest(evalCase, [booleanCriterion]).questions['answers-question'];
    expect(q?.type).toBe('choice');
    if (q?.type !== 'choice') throw new Error('expected choice');
    expect(Object.keys(q.criteria)).toEqual(['yes', 'no', 'escape']);
    expect(q.criteria['escape']).toBe(booleanCriterion.escape);
    expect(q.instructions.startsWith(booleanCriterion.instructions)).toBe(true);
    expect(q.instructions).toContain(booleanCriterion.escape);
  });

  test('choice criterion gains the escape option; score criterion passes through', () => {
    const { questions } = buildRequest(evalCase, criteria);
    const tone = questions['tone'];
    if (tone?.type !== 'choice') throw new Error('expected choice');
    expect(Object.keys(tone.criteria)).toEqual(['polite', 'neutral', 'rude', 'escape']);
    expect(tone.criteria['escape']).toBe(choiceCriterion.escape);
    expect(questions['helpfulness']).toEqual({
      type: 'score',
      instructions: scoreCriterion.instructions,
      criteria: scoreCriterion.criteria,
    });
  });

  test('two criteria with identical wordingHash still yield two questions', () => {
    const twin: Criterion = { ...booleanCriterion, id: 'twin' };
    const req = buildRequest(evalCase, [booleanCriterion, twin]);
    expect(Object.keys(req.questions)).toEqual(['answers-question', 'twin']);
  });

  test('judged content sits in state only, never in any question field', () => {
    // Default switched to fenced-v1 after the request-format A/B; this asserts the raw state.
    const built = buildRequest(evalCase, criteria, { requestFormat: 'raw' });
    expect(built.state).toContain(SENTINEL);
    expect(built.state).toBe(evalCase.input.state);
    expect(JSON.stringify(built.questions)).not.toContain(SENTINEL);
  });

  test('reference grader renders expected into instructions, never into state', () => {
    const req = buildRequest(referenceCase, [referenceCriterion]);
    const q = req.questions['capital-correct'];
    expect(q?.instructions).toContain('Canberra');
    expect(req.state).not.toContain('Canberra');
  });

  test('optionOrder reorders choice and compiled boolean options without changing keys', () => {
    const req = buildRequest(evalCase, criteria, {
      optionOrder: {
        'answers-question': ['escape', 'no', 'yes'],
        tone: ['rude', 'neutral', 'polite', 'escape'],
      },
    });
    const b = req.questions['answers-question'];
    const t = req.questions['tone'];
    if (b?.type !== 'choice' || t?.type !== 'choice') throw new Error('expected choice');
    expect(Object.keys(b.criteria)).toEqual(['escape', 'no', 'yes']);
    expect(Object.keys(t.criteria)).toEqual(['rude', 'neutral', 'polite', 'escape']);
    expect(t.criteria['rude']).toBe('The reply is dismissive or insulting.');
  });
});

describe('cacheKey', () => {
  test('is a sha256 hex digest that changes with state, wording and model', () => {
    const base = cacheKey(evalCase, criteria, 'jev-1.13.0');
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(cacheKey(evalCase, criteria, 'jev-1.13.0')).toBe(base);
    expect(cacheKey(evalCase, criteria, 'jev-1.14.0')).not.toBe(base);
    const reworded: Criterion = { ...booleanCriterion, wordingHash: 'hash-z' };
    expect(cacheKey(evalCase, [reworded, choiceCriterion, scoreCriterion], 'jev-1.13.0')).not.toBe(
      base,
    );
    const otherState: Case = { ...evalCase, input: { state: '{"reply":"other"}' } };
    expect(cacheKey(otherState, criteria, 'jev-1.13.0')).not.toBe(base);
  });

  test('differs per repeat index', () => {
    const base = cacheKey(evalCase, criteria, 'm');
    expect(cacheKey(evalCase, criteria, 'm', { repeat: 0 })).toBe(base);
    const one = cacheKey(evalCase, criteria, 'm', { repeat: 1 });
    expect(one).not.toBe(base);
    expect(cacheKey(evalCase, criteria, 'm', { repeat: 2 })).not.toBe(one);
  });

  test('differs per transport', () => {
    expect(cacheKey(evalCase, criteria, 'm', { transport: 'a' })).not.toBe(
      cacheKey(evalCase, criteria, 'm', { transport: 'b' }),
    );
  });

  test('differs when the core version differs (inject via options.coreVersion for the test)', () => {
    expect(cacheKey(evalCase, criteria, 'm', { coreVersion: '1.0.0' })).not.toBe(
      cacheKey(evalCase, criteria, 'm', { coreVersion: '1.0.1' }),
    );
  });

  test('raw and fenced-v1 keys differ and raw is no longer the bare material', () => {
    const raw = cacheKey(evalCase, [booleanCriterion], 'm', { requestFormat: 'raw' });
    expect(raw).not.toBe(
      cacheKey(evalCase, [booleanCriterion], 'm', { requestFormat: 'fenced-v1' }),
    );
    const bare = JSON.stringify({
      state: evalCase.input.state,
      wording: [[booleanCriterion.id, booleanCriterion.wordingHash]],
      model: 'm',
      references: [[booleanCriterion.id, undefined]],
      optionOrder: [[booleanCriterion.id, null]],
    });
    expect(raw).not.toBe(createHash('sha256').update(bare).digest('hex'));
  });

  test('changing expected.value changes the key for a reference criterion', () => {
    const a = cacheKey(referenceCase, [referenceCriterion], 'jev-1.13.0');
    const other: Case = { ...referenceCase, expected: { value: 'Sydney', source: 'user' } };
    expect(cacheKey(other, [referenceCriterion], 'jev-1.13.0')).not.toBe(a);
  });
});

function rejecting(code: CevErrorCode, details?: VetErrorDetails): FakeJudge {
  return fakeJudge({
    impl: () =>
      Promise.reject(new VetError(code, `boom ${code}`, details === undefined ? {} : { details })),
  });
}

async function thrownBy(judge: JudgeV1): Promise<unknown> {
  try {
    await judgeCase({ judge, case: evalCase, criteria });
  } catch (err) {
    return err;
  }
  throw new Error('expected judgeCase to throw');
}

describe('judgeCase', () => {
  test('makes exactly one doJudge call carrying N=3 questions keyed by criterion id', async () => {
    const { judge, doJudge } = fakeJudge();
    const verdicts = await judgeCase({ judge, case: evalCase, criteria });
    expect(doJudge).toHaveBeenCalledTimes(1);
    const req = doJudge.mock.calls[0]?.[0];
    expect(Object.keys(req?.questions ?? {})).toEqual(['answers-question', 'tone', 'helpfulness']);
    expect(verdicts.map((v) => v.criterionId)).toEqual(['answers-question', 'tone', 'helpfulness']);
    expect(verdicts.every((v) => v.status === 'ok' && v.caseId === 'case-1')).toBe(true);
    for (const v of verdicts) expect(validateJson(v, verdictSchema).ok).toBe(true);
  });

  test('second identical call is a cache hit with zero doJudge invocations', async () => {
    const cache = createFileCache(dir);
    const first = fakeJudge();
    const v1 = await judgeCase({ judge: first.judge, case: evalCase, criteria, cache });
    expect(v1.every((v) => !v.cacheHit)).toBe(true);

    const second = fakeJudge();
    const v2 = await judgeCase({ judge: second.judge, case: evalCase, criteria, cache });
    expect(second.doJudge).not.toHaveBeenCalled();
    expect(v2.every((v) => v.cacheHit)).toBe(true);
    expect(v2.map((v) => v.answer)).toEqual(v1.map((v) => v.answer));
    expect(v2[0]?.model.resolved).toBe('jev-1.13.0');
    for (const v of v2) expect(validateJson(v, verdictSchema).ok).toBe(true);
  });

  test('cache entries never persist the raw response body', async () => {
    const cache = createFileCache(dir);
    const { judge } = fakeJudge();
    await judgeCase({ judge, case: evalCase, criteria, cache });
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(1);
    expect(readFileSync(join(dir, files[0] ?? ''), 'utf8')).not.toContain('never-cached');
  });

  test('an entry cached under a different judge model identity is a miss', async () => {
    const cache = createFileCache(dir);
    await judgeCase({
      judge: fakeJudge({ model: 'model-a' }).judge,
      case: evalCase,
      criteria,
      cache,
    });
    const other = fakeJudge({ model: 'model-b' });
    const v = await judgeCase({ judge: other.judge, case: evalCase, criteria, cache });
    expect(other.doJudge).toHaveBeenCalledTimes(1);
    expect(v.every((x) => !x.cacheHit)).toBe(true);
  });

  test('two judges with the same id but different capabilities.model get different keys (miss)', async () => {
    const get = vi.fn<VerdictCache['get']>(() => Promise.resolve(undefined));
    const set = vi.fn<VerdictCache['set']>(() => Promise.resolve());
    const cache: VerdictCache = { get, set };
    await judgeCase({
      judge: fakeJudge({ model: 'jev-1.13.0' }).judge,
      case: evalCase,
      criteria,
      cache,
    });
    await judgeCase({
      judge: fakeJudge({ model: 'jev-1.14.0' }).judge,
      case: evalCase,
      criteria,
      cache,
    });
    const keys = get.mock.calls.map((c) => c[0]);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(cacheKey(evalCase, criteria, 'jev-1.13.0', { transport: 'fake' }));
    expect(keys[1]).toBe(cacheKey(evalCase, criteria, 'jev-1.14.0', { transport: 'fake' }));
    expect(keys[0]).not.toBe(keys[1]);
  });

  test('an unscored verdict reports model.requested = capabilities.model, not the judge id', async () => {
    const failing = fakeJudge({
      id: 'jev-vercel',
      model: 'typesafe-ai/jev',
      impl: () => Promise.reject(new VetError(CEV_ERROR_CODES.JUDGE_UNAVAILABLE, 'down')),
    });
    const verdicts = await judgeCase({ judge: failing.judge, case: evalCase, criteria });
    expect(
      verdicts.every((v) => v.status === 'unscored' && v.model.requested === 'typesafe-ai/jev'),
    ).toBe(true);
  });

  test('a doJudge rejection yields unscored verdicts with cause = code, no throw, nothing cached', async () => {
    const cache = createFileCache(dir);
    const failing = fakeJudge({
      impl: () => Promise.reject(new VetError(CEV_ERROR_CODES.JUDGE_TIMEOUT, 'timed out')),
    });
    const verdicts = await judgeCase({ judge: failing.judge, case: evalCase, criteria, cache });
    expect(verdicts).toHaveLength(3);
    for (const v of verdicts) {
      expect(v.status).toBe('unscored');
      expect(v.cause).toBe('JUDGE_TIMEOUT');
      expect(v.cacheHit).toBe(false);
      expect(v.answer).toBeUndefined();
      expect(validateJson(v, verdictSchema).ok).toBe(true);
    }
    expect(readdirSync(dir).filter((f) => f.endsWith('.json'))).toHaveLength(0);
  });

  test('a 403 transport rejection preserves HTTP status and error type in cause, without body or key', async () => {
    const apiKey = 'sk-test-do-not-log-9f2c';
    const rejectionCause = {
      status: 403,
      body: { error: { type: 'no_providers_available' }, secretEcho: apiKey },
    };
    const failing = fakeJudge({
      impl: () =>
        Promise.reject(
          new VetError(
            CEV_ERROR_CODES.JUDGE_UNAVAILABLE,
            'judge unavailable (HTTP 403: no_providers_available)',
            {
              cause: rejectionCause,
              details: { retryable: false, hint: 'no_providers_available' },
            },
          ),
        ),
    });
    const verdicts = await judgeCase({ judge: failing.judge, case: evalCase, criteria });
    expect(verdicts).toHaveLength(3);
    for (const v of verdicts) {
      expect(v.status).toBe('unscored');
      const detail = JSON.stringify(v.cause);
      expect(detail).toContain('403');
      expect(detail).toContain('no_providers_available');
      expect(detail).not.toContain('secretEcho');
      expect(detail).not.toContain(apiKey);
      expect(detail).not.toContain('body');
    }
  });

  test('a missing answer key yields status error for that criterion only', async () => {
    const { judge } = fakeJudge({ drop: 'tone' });
    const verdicts = await judgeCase({ judge, case: evalCase, criteria });
    const byId = Object.fromEntries(verdicts.map((v) => [v.criterionId, v]));
    expect(byId['tone']?.status).toBe('error');
    expect(byId['tone']?.cause).toBe('JUDGE_BAD_RESPONSE');
    expect(byId['answers-question']?.status).toBe('ok');
    expect(byId['helpfulness']?.status).toBe('ok');
  });

  test('an already-aborted signal yields unscored JUDGE_TIMEOUT with no judge or cache I/O', async () => {
    const { judge, doJudge } = fakeJudge();
    const get = vi.fn<VerdictCache['get']>();
    const set = vi.fn<VerdictCache['set']>();
    const cache: VerdictCache = { get, set };
    const controller = new AbortController();
    controller.abort();
    const verdicts = await judgeCase({
      judge,
      case: evalCase,
      criteria,
      cache,
      signal: controller.signal,
    });
    expect(doJudge).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    expect(verdicts.every((v) => v.status === 'unscored' && v.cause === 'JUDGE_TIMEOUT')).toBe(
      true,
    );
  });

  describe('terminal judge errors', () => {
    test.each([
      ['terminal-auth is rethrown', 'JUDGE_UNAUTHORIZED', 'terminal-auth'],
      ['terminal-billing is rethrown', 'JUDGE_UNAVAILABLE', 'terminal-billing'],
      ['terminal-request is rethrown', 'JUDGE_BAD_RESPONSE', 'terminal-request'],
    ] as const)('%s', async (_name, code, kind) => {
      const details: VetErrorDetails = { kind, retryable: false, hint: 'h' };
      const original = new VetError(code, 'exact message', { details });
      const judge = fakeJudge({ impl: () => Promise.reject(original) }).judge;
      const thrown = await thrownBy(judge);
      expect(thrown).toBe(original);
      expect(VetError.isInstance(thrown) && thrown.code).toBe(code);
      expect(VetError.isInstance(thrown) && thrown.message).toBe('exact message');
      expect(VetError.isInstance(thrown) && thrown.details).toEqual(details);
    });

    test('retryable stays unscored', async () => {
      const { judge } = rejecting('JUDGE_UNAVAILABLE', { kind: 'retryable', retryable: true });
      const verdicts = await judgeCase({ judge, case: evalCase, criteria });
      expect(verdicts.every((v) => v.status === 'unscored')).toBe(true);
    });

    test('unknown error stays unscored', async () => {
      const plain = fakeJudge({ impl: () => Promise.reject(new TypeError('network down')) });
      const noKind = rejecting('JUDGE_UNAVAILABLE', { retryable: false, hint: 'x' });
      const noDetails = rejecting('JUDGE_UNAVAILABLE');
      for (const { judge } of [plain, noKind, noDetails]) {
        const verdicts = await judgeCase({ judge, case: evalCase, criteria });
        expect(verdicts).toHaveLength(3);
        expect(verdicts.every((v) => v.status === 'unscored')).toBe(true);
      }
    });

    test('an aborted signal still yields unscored JUDGE_TIMEOUT even for a terminal judge', async () => {
      const { judge, doJudge } = rejecting('JUDGE_UNAUTHORIZED', { kind: 'terminal-auth' });
      const controller = new AbortController();
      controller.abort();
      const verdicts = await judgeCase({
        judge,
        case: evalCase,
        criteria,
        signal: controller.signal,
      });
      expect(doJudge).not.toHaveBeenCalled();
      expect(verdicts.every((v) => v.status === 'unscored' && v.cause === 'JUDGE_TIMEOUT')).toBe(
        true,
      );
    });
  });

  test('forwards the signal to doJudge', async () => {
    const { judge, doJudge } = fakeJudge();
    const controller = new AbortController();
    await judgeCase({ judge, case: evalCase, criteria, signal: controller.signal });
    expect(doJudge.mock.calls[0]?.[0].signal).toBe(controller.signal);
  });
});

describe('createFileCache', () => {
  test('a corrupt cache file is a miss, emits a diag event, and is overwritten', async () => {
    const onDiag = vi.fn();
    const cache = createFileCache(dir, { onDiag });
    const key = cacheKey(evalCase, criteria, 'jev-fake-model', { transport: 'fake' });
    writeFileSync(join(dir, `${key}.json`), '{not json');

    const { judge, doJudge } = fakeJudge();
    const first = await judgeCase({ judge, case: evalCase, criteria, cache });
    expect(doJudge).toHaveBeenCalledTimes(1);
    expect(first.every((v) => !v.cacheHit)).toBe(true);
    expect(onDiag).toHaveBeenCalledWith(expect.objectContaining({ type: 'cache_corrupt', key }));

    const again = await judgeCase({ judge, case: evalCase, criteria, cache });
    expect(again.every((v) => v.cacheHit)).toBe(true);
  });

  test('get returns undefined for an absent key', async () => {
    const cache = createFileCache(dir);
    await expect(cache.get('a'.repeat(64))).resolves.toBeUndefined();
  });

  test('set leaves no temp files behind', async () => {
    const cache = createFileCache(dir);
    const { judge } = fakeJudge();
    await judgeCase({ judge, case: evalCase, criteria, cache });
    expect(readdirSync(dir).every((f) => f.endsWith('.json'))).toBe(true);
  });

  test('I/O failures surface as VetError CACHE_IO', async () => {
    const file = join(dir, 'not-a-dir');
    writeFileSync(file, 'x');
    const cache = createFileCache(join(file, 'cache'));
    const entry = {
      answers: {},
      usage: { inputTokens: 0, outputTokens: 0 },
      model: { requested: 'r', resolved: 'r', transport: 't', pinned: false },
    };
    const err: unknown = await cache.set('b'.repeat(64), entry).catch((e: unknown) => e);
    expect(VetError.isInstance(err)).toBe(true);
    expect(VetError.isInstance(err) && err.code).toBe('CACHE_IO');
  });

  test('rejects a key that is not a sha256 hex digest', async () => {
    const cache = createFileCache(dir);
    const err: unknown = await cache.get('../escape').catch((e: unknown) => e);
    expect(VetError.isInstance(err) && err.code).toBe('CACHE_IO');
  });
});

describe('requestFormat', () => {
  // Constants captured from the code before the request format existed.
  const fixedCase: Case = {
    id: 'c',
    input: { state: 'hello <b>\n"x"' },
    provenance: {},
    tags: [],
  };
  const fixedCriteria: Criterion[] = [
    {
      id: 'q',
      type: 'boolean',
      instructions: 'Ok?',
      escape: 'none',
      polarity: 'pass_when_true',
      channel: 'outcome',
      provenance: { traceIds: [] },
      wordingHash: 'h1',
    },
  ];
  const RAW_KEY = 'f5f284dc0b6a2fd50fb743b90164bf7fb2c47fb89d4bc272988924cba3321535';
  const RAW_REQUEST =
    '{"state":"hello <b>\\n\\"x\\"","questions":{"q":{"type":"choice","instructions":"Ok? Answer \\"escape\\" when: none","criteria":{"yes":"Yes.","no":"No.","escape":"none"}}}}';

  test('raw request equals the pre-change value', () => {
    // Default switched to fenced-v1 after the request-format A/B; raw is now explicit.
    expect(JSON.stringify(buildRequest(fixedCase, fixedCriteria, { requestFormat: 'raw' }))).toBe(
      RAW_REQUEST,
    );
  });

  test('fenced-v1 sends the rendered state and keys differently from raw', () => {
    const fenced = buildRequest(fixedCase, fixedCriteria, { requestFormat: 'fenced-v1' });
    expect(fenced.state).toBe(renderState(fixedCase.input.state, 'fenced-v1'));
    expect(cacheKey(fixedCase, fixedCriteria, 'm', { requestFormat: 'fenced-v1' })).not.toBe(
      RAW_KEY,
    );
  });

  test('an unset format resolves to fenced-v1 in buildRequest, cacheKey and judgeCase', async () => {
    expect(DEFAULT_REQUEST_FORMAT).toBe('fenced-v1');
    expect(buildRequest(fixedCase, fixedCriteria).state).toBe(
      renderState(fixedCase.input.state, 'fenced-v1'),
    );
    expect(cacheKey(fixedCase, fixedCriteria, 'm')).toBe(
      cacheKey(fixedCase, fixedCriteria, 'm', { requestFormat: 'fenced-v1' }),
    );
    const { judge, doJudge } = fakeJudge();
    await judgeCase({ judge, case: evalCase, criteria: [booleanCriterion] });
    expect(doJudge.mock.calls[0]?.[0].state).toBe(renderState(evalCase.input.state, 'fenced-v1'));
  });

  test('judgeCase fills the format from the judge capabilities', async () => {
    const { judge, doJudge } = fakeJudge();
    const fencedJudge: JudgeV1 = {
      ...judge,
      capabilities: { ...judge.capabilities, requestFormat: 'fenced-v1' },
    };
    await judgeCase({ judge: fencedJudge, case: evalCase, criteria: [booleanCriterion] });
    expect(doJudge.mock.calls[0]?.[0].state).toBe(renderState(evalCase.input.state, 'fenced-v1'));
  });
});

const terminal = (): VetError =>
  new VetError('JUDGE_UNAUTHORIZED', 'judge rejected the API key', {
    details: { kind: 'terminal-auth' },
  });

describe('runJudge on a terminal judge error', () => {
  const cases: Case[] = ['c1', 'c2', 'c3', 'c4', 'c5'].map((id) => ({ ...evalCase, id }));
  test('terminal error stops after one call', async () => {
    const { judge, doJudge } = fakeJudge({ impl: () => Promise.reject(terminal()) });
    const limiter = createLimiter({ maxInFlight: 1 });
    const err = await runJudge({ cases, criteria, judge, limiter }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(VetError.isInstance(err) && err.code).toBe('JUDGE_UNAUTHORIZED');
    expect(VetError.isInstance(err) && err.details?.kind).toBe('terminal-auth');
    expect(doJudge).toHaveBeenCalledTimes(1);
  });

  test('in-flight calls are bounded by the concurrency when a terminal error stops the run', async () => {
    const { judge, doJudge } = fakeJudge({ impl: () => Promise.reject(terminal()) });
    const limiter = createLimiter({ maxInFlight: 2 });
    await runJudge({ cases, criteria, judge, limiter }).catch(() => undefined);
    expect(doJudge.mock.calls.length).toBeLessThanOrEqual(2);
  });

  test('a terminal error after an earlier repeat succeeded is rethrown and partial verdicts are discarded', async () => {
    let calls = 0;
    const { judge } = fakeJudge({
      impl: (req) => {
        calls += 1;
        if (calls === 1) {
          return fakeJudge().doJudge(req);
        }
        return Promise.reject(terminal());
      },
    });
    const limiter = createLimiter({ maxInFlight: 1 });
    const err = await runJudge({
      cases: [evalCase],
      criteria,
      judge,
      limiter,
      repeats: 2,
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(VetError.isInstance(err) && err.code).toBe('JUDGE_UNAUTHORIZED');
  });

  test('a retryable failure does not stop the run', async () => {
    const { judge, doJudge } = fakeJudge({
      impl: () =>
        Promise.reject(
          new VetError('JUDGE_TIMEOUT', 'timed out', { details: { kind: 'retryable' } }),
        ),
    });
    const verdicts = await runJudge({ cases, criteria, judge });
    expect(doJudge).toHaveBeenCalledTimes(cases.length);
    expect(verdicts.every((v) => v.status === 'unscored')).toBe(true);
  });
});
