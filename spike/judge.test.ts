import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Trace } from './corpus.ts';
import type { Criterion } from './propose.ts';
import {
  MODEL,
  buildState,
  buildQuestions,
  cacheKey,
  callSystemOne,
  extractMeta,
  judgeOne,
  runJudge,
} from './judge.ts';

// The fields extractMeta reads, in the shape of a real gateway System One response.
const RESPONSE_FIXTURE = {
  model: 'typesafe-ai/jev',
  usage: { input_tokens: 446, output_tokens: 74 },
  provider_metadata: {
    gateway: { routing: { finalProvider: 'typesafe-ai' }, marketCost: '0.000018732' },
  },
};

function trace(overrides: Partial<Trace> = {}): Trace {
  return {
    traceId: 'bm25:en01-f1',
    variant: 'bm25',
    goldenId: 'en01-f1',
    lang: 'en',
    hops: 1,
    unanswerable: false,
    question: 'In what year was the Velmoor Water Authority founded?',
    answer: 'The Velmoor Water Authority was founded in 1974 [1].',
    contexts: [
      {
        docId: 'en_01_velmoor_water_authority.pdf',
        text: 'Velmoor Water Authority: founded 1974.',
      },
    ],
    reference: 'The Velmoor Water Authority was founded in 1974.',
    baseline: { faithfulness: 0.9, context_relevance: 0.9, judgeModel: 'gemini-3.1-pro-preview' },
    retrievedIds: ['en_01_velmoor_water_authority.pdf'],
    langfuseTraceId: 'lf-1',
    ...overrides,
  };
}

const CRITERIA: Criterion[] = [
  {
    id: 'c1',
    name: 'answer_correct',
    instructions:
      'The reference answer for this case is: {{reference}}. Does the answer state the same fact?',
    escape: 'reference not comparable',
    provenance: null,
  },
  {
    id: 'c2',
    name: 'abstains_when_unanswerable',
    instructions: 'Does the answer say that the provided documents contain no such information?',
    escape: 'unclear',
    provenance: null,
  },
];

function choiceAnswer(choice: string): {
  type: 'choice';
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
} {
  return { type: 'choice', choice, confidence: 0.9, probabilities: { [choice]: 0.9 } };
}

function stubResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    ...(init.headers ? { headers: init.headers } : {}),
  });
}

describe('buildState (unit)', () => {
  test('renders question, retrieved documents and answer, never the reference or baseline scores', () => {
    const t = trace();
    const state = buildState(t);

    expect(state).toContain(t.question);
    expect(state).toContain(t.contexts[0]?.text ?? '');
    expect(state).toContain(t.answer);
    expect(t.reference).toBeTruthy();
    expect(state).not.toContain(t.reference ?? '');
    expect(state).not.toContain('0.9');
  });
});

describe('buildQuestions (unit)', () => {
  test('renders the golden reference into c1 instructions only', () => {
    const t = trace();
    const questions = buildQuestions(CRITERIA, t);

    expect(t.reference).toBeTruthy();
    expect(questions.c1?.instructions).toContain(t.reference ?? '');
    expect(questions.c1?.instructions).not.toContain('{{reference}}');
    expect(questions.c2?.instructions).toBe(CRITERIA[1]?.instructions);
  });

  test('sends every criterion as a 3-way choice with the criterion escape label as the third option', () => {
    const t = trace();
    const questions = buildQuestions(CRITERIA, t);

    expect(questions.c2?.type).toBe('choice');
    expect(Object.keys(questions.c2?.criteria ?? {})).toEqual(['yes', 'no', 'escape']);
    expect(questions.c2?.criteria.escape).toBe('unclear');
  });

  test('request body matches the gateway fixture field names (instructions, type, criteria)', () => {
    const t = trace();
    const questions = buildQuestions(CRITERIA, t);
    const body = {
      model: MODEL,
      state: buildState(t),
      questions,
      providerOptions: { gateway: { only: ['typesafe-ai'], zeroDataRetention: true } },
    };

    expect(body.model).toBe('typesafe-ai/jev');
    expect(body.questions.c1).toHaveProperty('instructions');
    expect(body.questions.c1).toHaveProperty('type');
    expect(body.providerOptions.gateway).toEqual({
      only: ['typesafe-ai'],
      zeroDataRetention: true,
    });
  });
});

describe('cacheKey (unit)', () => {
  test('changes when the repeat index changes, so repeats never collide', () => {
    const state = 'same state';
    const questions = {
      c1: { type: 'choice', instructions: 'x', criteria: { yes: 'y', no: 'n', escape: 'e' } },
    };

    const k0 = cacheKey(state, questions, 0, MODEL);
    const k1 = cacheKey(state, questions, 1, MODEL);

    expect(k0).not.toBe(k1);
  });

  test('is stable for identical inputs', () => {
    const state = 'same state';
    const questions = {
      c1: { type: 'choice', instructions: 'x', criteria: { yes: 'y', no: 'n', escape: 'e' } },
    };

    expect(cacheKey(state, questions, 0, MODEL)).toBe(cacheKey(state, questions, 0, MODEL));
  });
});

describe('extractMeta (unit, gateway response shape)', () => {
  test('reads model, finalProvider, usage and marketCost from the fixture shape', async () => {
    const meta = extractMeta(RESPONSE_FIXTURE);

    expect(meta.model).toBe('typesafe-ai/jev');
    expect(meta.finalProvider).toBe('typesafe-ai');
    expect(meta.inputTokens).toBe(446);
    expect(meta.outputTokens).toBe(74);
    expect(meta.marketCost).toBeCloseTo(0.000018732, 9);
  });
});

describe('callSystemOne (unit, fetch stubbed)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  test('sends an AbortSignal.timeout-bounded request with the bearer key', async () => {
    fetchSpy.mockResolvedValue(
      stubResponse({ model: MODEL, answers: {}, usage: {}, provider_metadata: { gateway: {} } }),
    );

    await callSystemOne('https://gw.example', 'test-key', { model: MODEL }, {});

    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(String(url)).toContain('/typesafe/v1/systemone');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-key');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  test('retries once after a 429 then succeeds, without a second retry', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        stubResponse({ error: 'rate limited' }, { status: 429, headers: { 'retry-after': '1' } }),
      )
      .mockResolvedValueOnce(
        stubResponse({ model: MODEL, answers: {}, usage: {}, provider_metadata: { gateway: {} } }),
      );

    const result = await callSystemOne(
      'https://gw.example',
      'test-key',
      { model: MODEL },
      { sleep: async () => {} },
    );

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
  });

  test('a persistent 500 fails after exactly one retry, never throwing', async () => {
    fetchSpy.mockResolvedValue(stubResponse({ error: 'boom' }, { status: 500 }));

    const result = await callSystemOne(
      'https://gw.example',
      'test-key',
      { model: MODEL },
      { sleep: async () => {} },
    );

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ ok: false, cause: 'http 500' });
  });
});

describe('judgeOne (unit, fetch + disk cache stubbed)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let cacheDir: string;

  beforeEach(async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    cacheDir = await mkdtemp(join(tmpdir(), 'vetkit-judge-cache-'));
  });

  afterEach(async () => {
    fetchSpy.mockRestore();
    await rm(cacheDir, { recursive: true, force: true });
  });

  test('records one ok row per criterion from a single call, mapping yes/no/escape to true/false/null', async () => {
    fetchSpy.mockResolvedValue(
      stubResponse({
        model: MODEL,
        answers: { c1: choiceAnswer('yes'), c2: choiceAnswer('escape') },
        usage: { input_tokens: 100, output_tokens: 5 },
        provider_metadata: {
          gateway: { routing: { finalProvider: 'typesafe-ai' }, marketCost: '0.00001' },
        },
      }),
    );

    const outcome = await judgeOne(trace(), 0, CRITERIA, cacheDir, {
      base: 'https://gw.example',
      apiKey: 'k',
    });

    expect(outcome.rows).toEqual([
      {
        traceId: 'bm25:en01-f1',
        criterionId: 'c1',
        repeat: 0,
        noul: true,
        model: MODEL,
        provider: 'typesafe-ai',
        status: 'ok',
      },
      {
        traceId: 'bm25:en01-f1',
        criterionId: 'c2',
        repeat: 0,
        noul: null,
        model: MODEL,
        provider: 'typesafe-ai',
        status: 'ok',
      },
    ]);
    expect(outcome.networkCall).toBe(true);
  });

  test('a missing answer key is recorded unscored with cause "missing answer"', async () => {
    fetchSpy.mockResolvedValue(
      stubResponse({
        model: MODEL,
        answers: { c1: choiceAnswer('no') },
        usage: { input_tokens: 10, output_tokens: 1 },
        provider_metadata: { gateway: {} },
      }),
    );

    const outcome = await judgeOne(trace(), 0, CRITERIA, cacheDir, {
      base: 'https://gw.example',
      apiKey: 'k',
    });

    expect(outcome.rows.find((r) => r.criterionId === 'c2')).toEqual({
      traceId: 'bm25:en01-f1',
      criterionId: 'c2',
      repeat: 0,
      noul: null,
      model: MODEL,
      provider: null,
      status: 'unscored',
      cause: 'missing answer',
    });
  });

  test('a persistent failure records every criterion unscored with the failure cause, and never throws', async () => {
    fetchSpy.mockResolvedValue(stubResponse({ error: 'down' }, { status: 500 }));

    const outcome = await judgeOne(trace(), 0, CRITERIA, cacheDir, {
      base: 'https://gw.example',
      apiKey: 'k',
      sleep: async () => {},
    });

    expect(outcome.rows).toHaveLength(2);
    for (const row of outcome.rows) {
      expect(row.status).toBe('unscored');
      expect(row.cause).toBe('http 500');
    }
  });

  test('the second call for the same trace, criteria and repeat is served from the disk cache with no network call', async () => {
    fetchSpy.mockResolvedValue(
      stubResponse({
        model: MODEL,
        answers: { c1: choiceAnswer('yes'), c2: choiceAnswer('no') },
        usage: { input_tokens: 10, output_tokens: 1 },
        provider_metadata: { gateway: {} },
      }),
    );

    const first = await judgeOne(trace(), 0, CRITERIA, cacheDir, {
      base: 'https://gw.example',
      apiKey: 'k',
    });
    fetchSpy.mockClear();
    const second = await judgeOne(trace(), 0, CRITERIA, cacheDir, {
      base: 'https://gw.example',
      apiKey: 'k',
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(second.networkCall).toBe(false);
    expect(second.rows).toEqual(first.rows);
  });

  test('a different repeat index for the same trace is a distinct network call, not a cache hit', async () => {
    fetchSpy.mockImplementation(async () =>
      stubResponse({
        model: MODEL,
        answers: { c1: choiceAnswer('yes'), c2: choiceAnswer('no') },
        usage: { input_tokens: 10, output_tokens: 1 },
        provider_metadata: { gateway: {} },
      }),
    );

    await judgeOne(trace(), 0, CRITERIA, cacheDir, { base: 'https://gw.example', apiKey: 'k' });
    fetchSpy.mockClear();
    const outcome = await judgeOne(trace(), 1, CRITERIA, cacheDir, {
      base: 'https://gw.example',
      apiKey: 'k',
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(outcome.networkCall).toBe(true);
  });
});

describe('runJudge (integration, fetch stubbed, real second-run cache proof)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let cacheDir: string;

  beforeEach(async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    cacheDir = await mkdtemp(join(tmpdir(), 'vetkit-judge-run-'));
  });

  afterEach(async () => {
    fetchSpy.mockRestore();
    await rm(cacheDir, { recursive: true, force: true });
  });

  test('a second run over the same traces logs cache hits: N, network: 0', async () => {
    fetchSpy.mockImplementation(async () =>
      stubResponse({
        model: MODEL,
        answers: { c1: choiceAnswer('yes'), c2: choiceAnswer('no') },
        usage: { input_tokens: 10, output_tokens: 1 },
        provider_metadata: {
          gateway: { routing: { finalProvider: 'typesafe-ai' }, marketCost: '0.00001' },
        },
      }),
    );
    const traces = [trace(), trace({ traceId: 'bm25:en02-f1', goldenId: 'en02-f1' })];

    const firstRun = await runJudge(traces, CRITERIA, cacheDir, {
      base: 'https://gw.example',
      apiKey: 'k',
      concurrency: 2,
      repeats: 1,
    });
    expect(firstRun.networkCalls).toBe(2);
    expect(firstRun.cacheHits).toBe(0);

    fetchSpy.mockClear();
    const secondRun = await runJudge(traces, CRITERIA, cacheDir, {
      base: 'https://gw.example',
      apiKey: 'k',
      concurrency: 2,
      repeats: 1,
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(secondRun.networkCalls).toBe(0);
    expect(secondRun.cacheHits).toBe(2);
    expect(secondRun.rows).toHaveLength(4);
  });

  test('never logs the api key, request bodies or trace state text', async () => {
    fetchSpy.mockImplementation(async () =>
      stubResponse({
        model: MODEL,
        answers: { c1: choiceAnswer('yes'), c2: choiceAnswer('no') },
        usage: { input_tokens: 10, output_tokens: 1 },
        provider_metadata: { gateway: {} },
      }),
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const t = trace();

    await runJudge([t], CRITERIA, cacheDir, {
      base: 'https://gw.example',
      apiKey: 'super-secret-key',
      concurrency: 1,
    });

    const allOutput = [...logSpy.mock.calls, ...errSpy.mock.calls].flat().join(' ');
    expect(allOutput).not.toContain('super-secret-key');
    expect(allOutput).not.toContain('Authorization');
    expect(allOutput).not.toContain(t.question);
    expect(allOutput).not.toContain(t.contexts[0]?.text ?? '');

    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  test('prints a progress line naming the completed and total call count, for polling during a long live run', async () => {
    fetchSpy.mockImplementation(async () =>
      stubResponse({
        model: MODEL,
        answers: { c1: choiceAnswer('yes'), c2: choiceAnswer('no') },
        usage: { input_tokens: 10, output_tokens: 1 },
        provider_metadata: { gateway: {} },
      }),
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const traces = [trace(), trace({ traceId: 'bm25:en02-f1', goldenId: 'en02-f1' })];

    await runJudge(traces, CRITERIA, cacheDir, {
      base: 'https://gw.example',
      apiKey: 'k',
      concurrency: 2,
      repeats: 1,
    });

    const lines = logSpy.mock.calls.flat().map(String);
    expect(lines.some((line) => line.startsWith('2/2 calls'))).toBe(true);

    logSpy.mockRestore();
  });
});
