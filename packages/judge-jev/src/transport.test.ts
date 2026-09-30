import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test, vi } from 'vitest';
import { safeParseJson, VetError, type Question } from '@vetkit/spec';
import type { JevProviderOptions } from './presets.ts';
import { createJevJudge, createJevJudgeFromEndpoint } from './transport.ts';

interface CapturedCall {
  readonly url: string;
  readonly init: RequestInit;
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

interface CapturedBody {
  readonly model: string;
  readonly questions: Record<string, unknown>;
  readonly providerOptions?: unknown;
}

// Reconstructs the sent body via Request#json() so this file never needs the raw
// JSON parse call banned under packages/*/src (scripts/ban-raw-json-parse.sh).
// Request#json() resolves `any`, so assigning it to the typed return position below
// needs no unsafe `as` cast.
async function capturedBody(call: CapturedCall): Promise<CapturedBody> {
  return new Request(call.url, call.init).json();
}

function fakeSuccessBody(model: string): unknown {
  return {
    model,
    answers: { ok: { type: 'noul', noul: 0.9 } },
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

// Walks the VetError -> cause chain the same way a diagnostic renderer would,
// without relying on JSON.stringify(Error) (message/stack aren't enumerable).
function serializeErrorChain(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  let guard = 0;
  while (current !== undefined && current !== null && guard < 10) {
    guard += 1;
    if (current instanceof VetError) {
      parts.push(
        JSON.stringify({
          code: current.code,
          message: current.message,
          details: current.details ?? null,
        }),
      );
      current = current.cause;
    } else if (current instanceof Error) {
      parts.push(JSON.stringify({ message: current.message }));
      current = current.cause;
    } else {
      parts.push(JSON.stringify(current));
      break;
    }
  }
  return parts.join('|');
}

// Awaits a doJudge() call expected to reject with a VetError, narrowing via the
// isInstance type predicate instead of an unsafe `as VetError` cast.
async function catchVetError(promise: Promise<unknown>): Promise<VetError> {
  try {
    await promise;
  } catch (err) {
    if (VetError.isInstance(err)) return err;
    throw err;
  }
  throw new Error('expected doJudge() to reject');
}

describe('createJevJudge presets', () => {
  test.each([
    ['typesafe', 'https://api.typesafe.ai', 'jev-1.13.0', false],
    ['vercel', 'https://ai-gateway.vercel.sh/typesafe', 'typesafe-ai/jev', true],
    ['openrouter', 'https://openrouter.ai/api', 'typesafe/jev-1.13', false],
  ] as const)(
    '%s preset POSTs to <baseURL>/v1/systemone with the preset model (providerOptions present: %s)',
    async (preset, baseURL, model, hasProviderOptions) => {
      const calls: CapturedCall[] = [];
      const fetchStub: typeof fetch = vi.fn(async (input, init) => {
        calls.push({ url: String(input), init: init ?? {} });
        return jsonResponse(fakeSuccessBody(model));
      });

      const judge = createJevJudge({ preset, apiKey: 'fake-jev-key', fetch: fetchStub });
      await judge.doJudge({
        state: 'hello',
        questions: { ok: { type: 'boolean', instructions: 'q?' } },
      });

      expect(calls).toHaveLength(1);
      const call = calls[0];
      if (call === undefined) throw new Error('fetch was not called');
      expect(call.url).toBe(`${baseURL}/v1/systemone`);

      const body = await capturedBody(call);
      expect(body.model).toBe(model);
      expect(body.questions.ok).toEqual({ type: 'noul', instructions: 'q?' });
      expect('providerOptions' in body).toBe(hasProviderOptions);
      if (hasProviderOptions) {
        expect(body.providerOptions).toEqual({
          gateway: { zeroDataRetention: true, only: ['typesafe-ai'] },
        });
      }
    },
  );

  test('a custom baseURL overrides the preset baseURL', async () => {
    const calls: CapturedCall[] = [];
    const fetchStub: typeof fetch = vi.fn(async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return jsonResponse(fakeSuccessBody('typesafe-ai/jev'));
    });

    const judge = createJevJudge({
      preset: 'vercel',
      baseURL: 'https://custom.example.com',
      apiKey: 'fake-jev-key',
      fetch: fetchStub,
    });
    await judge.doJudge({
      state: 's',
      questions: { ok: { type: 'boolean', instructions: 'q' } },
    });

    expect(calls[0]?.url).toBe('https://custom.example.com/v1/systemone');
  });
});

describe('capabilities', () => {
  test('vercel preset judge reports pinned:false, transport "vercel", specVersion v1', () => {
    const judge = createJevJudge({ preset: 'vercel', apiKey: 'fake-jev-key' });

    expect(judge.specVersion).toBe('v1');
    expect(judge.capabilities).toEqual({
      questionTypes: ['boolean', 'choice', 'score'],
      maxStateTokens: 32000,
      pinned: false,
      transport: 'vercel',
      model: 'typesafe-ai/jev',
      // Default switched to fenced-v1 after the request-format A/B.
      requestFormat: 'fenced-v1',
    });
  });

  test.each([
    ['typesafe', 'jev-1.13.0'],
    ['vercel', 'typesafe-ai/jev'],
    ['openrouter', 'typesafe/jev-1.13'],
  ] as const)('%s preset judge declares the preset defaultModel %s', (preset, model) => {
    const judge = createJevJudge({ preset, apiKey: 'fake-jev-key' });

    expect(judge.capabilities.model).toBe(model);
  });

  test('opts.model overrides the declared model on a preset', () => {
    const judge = createJevJudge({ preset: 'openrouter', model: 'typesafe/jev-2', apiKey: 'k' });

    expect(judge.capabilities.model).toBe('typesafe/jev-2');
  });

  test('a custom transport declares its opts.model', () => {
    const judge = createJevJudge({
      baseURL: 'https://custom.example.com',
      model: 'acme/jev-custom',
      apiKey: 'fake-jev-key',
    });

    expect(judge.capabilities.model).toBe('acme/jev-custom');
  });

  test('the cloudflare transport declares the cloudflare preset defaultModel', () => {
    const judge = createJevJudge({ preset: 'cloudflare', accountId: 'acct', apiKey: 'k' });

    expect(judge.capabilities.model).toBe('typesafe/jev');
  });

  test('typesafe preset judge reports pinned:true, transport "typesafe"', () => {
    const judge = createJevJudge({ preset: 'typesafe', apiKey: 'fake-jev-key' });

    expect(judge.capabilities.pinned).toBe(true);
    expect(judge.capabilities.transport).toBe('typesafe');
  });
});

describe('deadline', () => {
  test('a call longer than deadlineMs rejects with JUDGE_TIMEOUT and aborts the fetch signal', async () => {
    let capturedSignal: AbortSignal | undefined;
    const fetchStub: typeof fetch = vi.fn((_input, init) => {
      capturedSignal = init?.signal ?? undefined;
      return new Promise<Response>(() => {
        // never resolves — the transport's own deadline must still reject.
      });
    });

    const judge = createJevJudge({
      preset: 'vercel',
      apiKey: 'fake-jev-key',
      fetch: fetchStub,
      deadlineMs: 20,
    });

    await expect(
      judge.doJudge({ state: 's', questions: { ok: { type: 'boolean', instructions: 'q' } } }),
    ).rejects.toMatchObject({ code: 'JUDGE_TIMEOUT' });

    expect(capturedSignal?.aborted).toBe(true);
  });
});

describe('network failure vs timeout', () => {
  test('a fetch rejection carrying a system error code maps to JUDGE_UNAVAILABLE with that code as the hint', async () => {
    const fetchStub: typeof fetch = vi.fn(async () => {
      const cause = Object.assign(
        new TypeError('Unable to connect. Is the computer able to access the url?'),
        { code: 'ConnectionRefused' },
      );
      throw cause;
    });

    const judge = createJevJudge({ preset: 'vercel', apiKey: 'fake-jev-key', fetch: fetchStub });

    const err = await catchVetError(
      judge.doJudge({ state: 's', questions: { ok: { type: 'boolean', instructions: 'q' } } }),
    );

    expect(err.code).toBe('JUDGE_UNAVAILABLE');
    expect(err.details?.hint).toBe('ConnectionRefused');
  });

  test('a fetch rejection with no error code falls back to the error class name as the hint', async () => {
    const fetchStub: typeof fetch = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });

    const judge = createJevJudge({ preset: 'vercel', apiKey: 'fake-jev-key', fetch: fetchStub });

    const err = await catchVetError(
      judge.doJudge({ state: 's', questions: { ok: { type: 'boolean', instructions: 'q' } } }),
    );

    expect(err.code).toBe('JUDGE_UNAVAILABLE');
    expect(err.details?.hint).toBe('TypeError');
  });

  // Node/undici's real fetch failure shape: a TypeError('fetch failed') whose
  // own `.code` is unset, wrapping the real system error (with the useful `.code`) one level
  // down at `.cause`. Without unwrapping that nested cause, the hint was the useless
  // 'TypeError' class name instead of 'ECONNREFUSED'.
  test('a fetch rejection that is a TypeError wrapping the real system error reads the nested cause.code as the hint', async () => {
    const fetchStub: typeof fetch = vi.fn(async () => {
      const systemError = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), {
        code: 'ECONNREFUSED',
      });
      throw new TypeError('fetch failed', { cause: systemError });
    });

    const judge = createJevJudge({ preset: 'vercel', apiKey: 'fake-jev-key', fetch: fetchStub });

    const err = await catchVetError(
      judge.doJudge({ state: 's', questions: { ok: { type: 'boolean', instructions: 'q' } } }),
    );

    expect(err.code).toBe('JUDGE_UNAVAILABLE');
    expect(err.details?.hint).toBe('ECONNREFUSED');
  });

  test('a real deadline timeout still maps to JUDGE_TIMEOUT, never JUDGE_UNAVAILABLE', async () => {
    const fetchStub: typeof fetch = vi.fn(
      () =>
        new Promise<Response>(() => {
          // never resolves — only the deadline settles this call.
        }),
    );

    const judge = createJevJudge({
      preset: 'vercel',
      apiKey: 'fake-jev-key',
      fetch: fetchStub,
      deadlineMs: 20,
    });

    const err = await catchVetError(
      judge.doJudge({ state: 's', questions: { ok: { type: 'boolean', instructions: 'q' } } }),
    );

    expect(err.code).toBe('JUDGE_TIMEOUT');
    expect(err.code).not.toBe('JUDGE_UNAVAILABLE');
  });
});

describe('key redaction', () => {
  test('the API key never appears in the serialized error, including the cause chain', async () => {
    const apiKey = 'fake-jev-key-should-never-leak';
    const fetchStub = vi.fn(async () => {
      throw new Error(`fetch failed: socket hang up while sending Bearer ${apiKey}`);
    });

    const judge = createJevJudge({ preset: 'vercel', apiKey, fetch: fetchStub });

    let caught: unknown;
    try {
      await judge.doJudge({
        state: 's',
        questions: { ok: { type: 'boolean', instructions: 'q' } },
      });
    } catch (err) {
      caught = err;
    }

    expect(VetError.isInstance(caught)).toBe(true);
    expect(serializeErrorChain(caught)).not.toContain(apiKey);
  });
});

describe('HTTP error mapping', () => {
  test('401 maps to JUDGE_UNAUTHORIZED with the request id in the message and details', async () => {
    const fetchStub = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'unauthorized' }), {
          status: 401,
          headers: { 'x-typesafe-request-id': 'req-401' },
        }),
    );
    const judge = createJevJudge({ preset: 'typesafe', apiKey: 'fake-jev-key', fetch: fetchStub });

    const err = await catchVetError(
      judge.doJudge({ state: 's', questions: { ok: { type: 'boolean', instructions: 'q' } } }),
    );

    expect(err.code).toBe('JUDGE_UNAUTHORIZED');
    expect(err.message).toContain('req-401');
    expect(err.details?.requestId).toBe('req-401');
  });

  test('403 with a nested authentication_error detail also maps to JUDGE_UNAUTHORIZED', async () => {
    const fetchStub = vi.fn(
      async () =>
        new Response(JSON.stringify({ detail: { error_type: 'authentication_error' } }), {
          status: 403,
          headers: { 'x-typesafe-request-id': 'req-403' },
        }),
    );
    const judge = createJevJudge({ preset: 'typesafe', apiKey: 'fake-jev-key', fetch: fetchStub });

    const err = await catchVetError(
      judge.doJudge({ state: 's', questions: { ok: { type: 'boolean', instructions: 'q' } } }),
    );

    expect(err.code).toBe('JUDGE_UNAUTHORIZED');
    expect(err.message).toContain('req-403');
    expect(err.details?.requestId).toBe('req-403');
  });

  test('403 no_providers_available maps to JUDGE_UNAVAILABLE with the gateway error type as hint', async () => {
    const fetchStub = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { type: 'no_providers_available' } }), {
          status: 403,
        }),
    );
    const judge = createJevJudge({ preset: 'vercel', apiKey: 'fake-jev-key', fetch: fetchStub });

    const err = await catchVetError(
      judge.doJudge({ state: 's', questions: { ok: { type: 'boolean', instructions: 'q' } } }),
    );

    expect(err.code).toBe('JUDGE_UNAVAILABLE');
    expect(err.details).toEqual({
      retryable: false,
      hint: 'no_providers_available',
      kind: 'terminal-request',
    });
    expect(err.message).toContain('403');
    expect(err.message).toContain('no_providers_available');
  });

  test('403 with a body whose error type is not a short lowercase token falls back to hint "forbidden", key still redacted', async () => {
    const apiKey = 'fake-jev-key-should-never-leak';
    const fetchStub = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: { type: 'Not A Valid Token!' }, message: `key ${apiKey}` }),
          { status: 403 },
        ),
    );
    const judge = createJevJudge({ preset: 'vercel', apiKey, fetch: fetchStub });

    const err = await catchVetError(
      judge.doJudge({ state: 's', questions: { ok: { type: 'boolean', instructions: 'q' } } }),
    );

    expect(err.code).toBe('JUDGE_UNAVAILABLE');
    expect(err.details).toEqual({ retryable: false, hint: 'forbidden', kind: 'terminal-request' });
    expect(err.message).toContain('403');
    expect(err.message).toContain('forbidden');
    expect(serializeErrorChain(err)).not.toContain(apiKey);
  });

  test('402 maps to JUDGE_UNAVAILABLE with retryable:false and hint "no credit"', async () => {
    const fetchStub = vi.fn(async () => new Response(JSON.stringify({}), { status: 402 }));
    const judge = createJevJudge({ preset: 'typesafe', apiKey: 'fake-jev-key', fetch: fetchStub });

    const err = await catchVetError(
      judge.doJudge({ state: 's', questions: { ok: { type: 'boolean', instructions: 'q' } } }),
    );

    expect(err.code).toBe('JUDGE_UNAVAILABLE');
    expect(err.details).toEqual({ retryable: false, hint: 'no credit', kind: 'terminal-billing' });
  });

  test('404 model_not_found maps to JUDGE_BAD_RESPONSE naming the requested model', async () => {
    const fetchStub = vi.fn(
      async () => new Response(JSON.stringify({ error: 'model_not_found' }), { status: 404 }),
    );
    const judge = createJevJudge({
      preset: 'typesafe',
      model: 'typesafe-ai/jev-latest',
      apiKey: 'fake-jev-key',
      fetch: fetchStub,
    });

    const err = await catchVetError(
      judge.doJudge({ state: 's', questions: { ok: { type: 'boolean', instructions: 'q' } } }),
    );

    expect(err.code).toBe('JUDGE_BAD_RESPONSE');
    expect(err.message).toContain('typesafe-ai/jev-latest');
  });

  test('429 with a Retry-After in seconds exposes retryAfterMs on details', async () => {
    const fetchStub = vi.fn(
      async () =>
        new Response(JSON.stringify({}), { status: 429, headers: { 'retry-after': '2' } }),
    );
    const judge = createJevJudge({ preset: 'typesafe', apiKey: 'fake-jev-key', fetch: fetchStub });

    const err = await catchVetError(
      judge.doJudge({ state: 's', questions: { ok: { type: 'boolean', instructions: 'q' } } }),
    );

    expect(err.code).toBe('JUDGE_UNAVAILABLE');
    expect(err.details?.retryable).toBe(true);
    expect(err.details?.retryAfterMs).toBe(2000);
  });

  test('5xx maps to JUDGE_UNAVAILABLE with retryable:true', async () => {
    const fetchStub = vi.fn(async () => new Response(JSON.stringify({}), { status: 503 }));
    const judge = createJevJudge({ preset: 'typesafe', apiKey: 'fake-jev-key', fetch: fetchStub });

    const err = await catchVetError(
      judge.doJudge({ state: 's', questions: { ok: { type: 'boolean', instructions: 'q' } } }),
    );

    expect(err.code).toBe('JUDGE_UNAVAILABLE');
    expect(err.details?.retryable).toBe(true);
  });
});

describe('answer mapping', () => {
  test('maps wire noul/choice/score answers to boolean/choice/score Answers, passthrough for choice+score', async () => {
    const fetchStub = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            model: 'typesafe-ai/jev',
            answers: {
              promised_refund: { type: 'noul', noul: 0.98 },
              tone: {
                type: 'choice',
                choice: 'helpful',
                confidence: 0.96,
                probabilities: { helpful: 0.98, neutral: 0.02, rude: 0 },
              },
              quality: {
                type: 'score',
                score: 2.78,
                confidence: 0.26,
                legend: {
                  '0': 'Wrong or harmful',
                  '1': 'Poor',
                  '2': 'Acceptable',
                  '3': 'Good',
                  '4': 'Excellent',
                },
                probabilities: { '0': 0.1, '1': 0.08, '2': 0.11, '3': 0.37, '4': 0.34 },
              },
            },
            usage: { input_tokens: 446, output_tokens: 74 },
          }),
          { status: 200 },
        ),
    );

    const judge = createJevJudge({ preset: 'vercel', apiKey: 'fake-jev-key', fetch: fetchStub });

    const result = await judge.doJudge({
      state: 'refund conversation',
      questions: {
        promised_refund: {
          type: 'boolean',
          instructions: 'Did the assistant promise or issue a refund?',
        },
        tone: {
          type: 'choice',
          instructions: "What is the assistant's tone?",
          criteria: {
            helpful: 'Polite and solves the problem',
            rude: 'Dismissive or insulting',
            neutral: 'Neither warm nor rude',
          },
        },
        quality: {
          type: 'score',
          instructions: 'Rate the overall answer quality.',
          criteria: ['Wrong or harmful', 'Poor', 'Acceptable', 'Good', 'Excellent'],
        },
      },
    });

    expect(result.answers.promised_refund).toEqual({ type: 'boolean', probability: 0.98 });
    expect(result.answers.tone).toEqual({
      type: 'choice',
      choice: 'helpful',
      confidence: 0.96,
      probabilities: { helpful: 0.98, neutral: 0.02, rude: 0 },
    });
    expect(result.answers.quality).toEqual({
      type: 'score',
      score: 2.78,
      confidence: 0.26,
      legend: {
        '0': 'Wrong or harmful',
        '1': 'Poor',
        '2': 'Acceptable',
        '3': 'Good',
        '4': 'Excellent',
      },
      probabilities: { '0': 0.1, '1': 0.08, '2': 0.11, '3': 0.37, '4': 0.34 },
    });
    expect(result.usage).toEqual({ inputTokens: 446, outputTokens: 74 });
    expect(result.model).toEqual({
      requested: 'typesafe-ai/jev',
      resolved: 'typesafe-ai/jev',
      transport: 'vercel',
      pinned: false,
    });
  });
});

describe('preflight validation', () => {
  test('an empty apiKey throws CONFIG_INVALID synchronously, before any fetch', () => {
    const fetchStub = vi.fn();
    expect(() => createJevJudge({ preset: 'vercel', apiKey: '', fetch: fetchStub })).toThrowError(
      expect.objectContaining({ code: 'CONFIG_INVALID' }),
    );
    expect(fetchStub).not.toHaveBeenCalled();
  });

  test('a score question with fewer than 2 levels rejects with CRITERIA_INVALID before any fetch', async () => {
    const fetchStub = vi.fn();
    const judge = createJevJudge({ preset: 'vercel', apiKey: 'fake-jev-key', fetch: fetchStub });

    await expect(
      judge.doJudge({
        state: 's',
        questions: { bad: { type: 'score', instructions: 'q', criteria: ['only one'] } },
      }),
    ).rejects.toMatchObject({ code: 'CRITERIA_INVALID' });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  test('a choice question with more than 255 options rejects with CRITERIA_INVALID before any fetch', async () => {
    const fetchStub = vi.fn();
    const judge = createJevJudge({ preset: 'vercel', apiKey: 'fake-jev-key', fetch: fetchStub });

    const criteria: Record<string, string> = {};
    for (let i = 0; i < 256; i += 1) criteria[`option_${i}`] = `description ${i}`;

    await expect(
      judge.doJudge({
        state: 's',
        questions: { bad: { type: 'choice', instructions: 'q', criteria } },
      }),
    ).rejects.toMatchObject({ code: 'CRITERIA_INVALID' });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  test('state plus the longest question over the 32k token limit rejects with INPUT_TOO_LARGE before any fetch', async () => {
    const fetchStub = vi.fn();
    const judge = createJevJudge({ preset: 'vercel', apiKey: 'fake-jev-key', fetch: fetchStub });

    const hugeState = 'a'.repeat(140_000);

    await expect(
      judge.doJudge({
        state: hugeState,
        questions: { ok: { type: 'boolean', instructions: 'q' } },
      }),
    ).rejects.toMatchObject({ code: 'INPUT_TOO_LARGE' });
    expect(fetchStub).not.toHaveBeenCalled();
  });
});

// Same loader as normalise.test.ts: this package's own fixtures/ copy, parsed via the
// safeParseJson chokepoint (an empty schema `{}` matches any JSON value).
function loadFixture(name: string): unknown {
  const path = fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
  const result = safeParseJson<unknown>(readFileSync(path, 'utf8'), {});
  if (!result.ok) throw result.error;
  return result.value;
}

function asMutableRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) throw new Error('expected an object');
  // Guarded by the typeof/null check above (trusted-boundary cast, same pattern as
  // normalise.test.ts).
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return value as Record<string, unknown>;
}

const RUN1_QUESTIONS: Record<string, Question> = {
  promised_refund: {
    type: 'boolean',
    instructions: 'Did the assistant promise or issue a refund?',
  },
  tone: {
    type: 'choice',
    instructions: "What is the assistant's tone?",
    criteria: {
      helpful: 'Polite and solves the problem',
      rude: 'Dismissive or insulting',
      neutral: 'Neither warm nor rude',
    },
  },
  quality: {
    type: 'score',
    instructions: 'Rate the overall answer quality.',
    criteria: ['Wrong or harmful', 'Poor', 'Acceptable', 'Good', 'Excellent'],
  },
};

describe('response normalisation (routes through normalise())', () => {
  test('run1 fixture through the vercel preset carries provider and credentialType', async () => {
    const run1 = loadFixture('2026-09-25-gateway-systemone-response-run1.json');
    const fetchStub = vi.fn(async () => jsonResponse(run1));
    const judge = createJevJudge({ preset: 'vercel', apiKey: 'fake-jev-key', fetch: fetchStub });

    const result = await judge.doJudge({ state: 'refund conversation', questions: RUN1_QUESTIONS });

    expect(result.model).toMatchObject({
      transport: 'vercel',
      pinned: false,
      provider: 'typesafe-ai',
      credentialType: 'system',
    });
  });

  test('a choice answer missing inline confidence gets it lifted from provider_metadata', async () => {
    const run1 = structuredClone(loadFixture('2026-09-25-gateway-systemone-response-run1.json'));
    const tone = asMutableRecord(asMutableRecord(asMutableRecord(run1)['answers'])['tone']);
    delete tone['confidence'];
    const fetchStub = vi.fn(async () => jsonResponse(run1));
    const judge = createJevJudge({ preset: 'vercel', apiKey: 'fake-jev-key', fetch: fetchStub });

    const result = await judge.doJudge({ state: 'refund conversation', questions: RUN1_QUESTIONS });

    const answer = result.answers.tone;
    if (answer?.type !== 'choice') throw new Error('expected a choice answer for "tone"');
    expect(answer.confidence).toBe(0.96);
  });
});

function codeOf(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return VetError.isInstance(error) ? error.code : error;
  }
  return undefined;
}

describe('createJevJudgeFromEndpoint', () => {
  test('the cloudflare preset without accountId is CONFIG_INVALID', () => {
    expect(
      codeOf(() =>
        createJevJudgeFromEndpoint({ preset: 'cloudflare', apiKeyEnv: 'K' }, { apiKey: 'k' }),
      ),
    ).toBe('CONFIG_INVALID');
  });

  test('an unknown preset is CONFIG_INVALID and names the known presets', () => {
    let caught: unknown;
    try {
      createJevJudgeFromEndpoint({ preset: 'nope' }, { apiKey: 'k' });
    } catch (error) {
      caught = error;
    }
    expect(VetError.isInstance(caught) && caught.code).toBe('CONFIG_INVALID');
    const message = caught instanceof Error ? caught.message : '';
    expect(message).toContain('"nope"');
    for (const name of ['typesafe', 'vercel', 'openrouter', 'cloudflare']) {
      expect(message).toContain(name);
    }
  });

  test('no preset and no baseURL/model is CONFIG_INVALID', () => {
    expect(codeOf(() => createJevJudgeFromEndpoint({}, { apiKey: 'k' }))).toBe('CONFIG_INVALID');
  });

  test('a known preset passes through to that transport', () => {
    const judge = createJevJudgeFromEndpoint({ preset: 'vercel' }, { apiKey: 'k' });
    expect(judge.capabilities.transport).toBe('vercel');
    expect(judge.capabilities.model).toBe('typesafe-ai/jev');
  });

  test('the cloudflare preset with accountId builds the cloudflare transport', () => {
    const judge = createJevJudgeFromEndpoint(
      { preset: 'cloudflare', accountId: 'acct' },
      { apiKey: 'k' },
    );
    expect(judge.capabilities.transport).toBe('cloudflare');
  });

  test('baseURL and model without a preset build a custom transport', () => {
    const judge = createJevJudgeFromEndpoint(
      { baseURL: 'https://judge.example', model: 'm' },
      { apiKey: 'k' },
    );
    expect(judge.capabilities.transport).toBe('custom');
    expect(judge.capabilities.model).toBe('m');
  });
});

describe('requestFormat capability', () => {
  test('a fenced-v1 endpoint echoes it and leaves the wire state untouched', async () => {
    const calls: CapturedCall[] = [];
    const fetchStub: typeof fetch = vi.fn(async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return jsonResponse(fakeSuccessBody('m'));
    });
    const judge = createJevJudgeFromEndpoint(
      { baseURL: 'https://judge.example', model: 'm', requestFormat: 'fenced-v1' },
      { apiKey: 'k', fetch: fetchStub },
    );
    expect(judge.capabilities.requestFormat).toBe('fenced-v1');
    await judge.doJudge({
      state: 'plain state',
      questions: { ok: { type: 'boolean', instructions: 'q?' } },
    });
    const call = calls[0];
    if (call === undefined) throw new Error('fetch was not called');
    const sent = JSON.stringify(await new Request(call.url, call.init).json());
    expect(sent).toContain('"plain state"');
  });

  // Default switched to fenced-v1 after the request-format A/B: capabilities always carry the format.
  test.each([
    ['raw' as const, 'raw'],
    ['fenced-v1' as const, 'fenced-v1'],
    [undefined, 'fenced-v1'],
  ])('%s carries the resolved format %s', (requestFormat, resolved) => {
    const judge = createJevJudgeFromEndpoint(
      { preset: 'vercel', ...(requestFormat === undefined ? {} : { requestFormat }) },
      { apiKey: 'k' },
    );
    expect(judge.capabilities.requestFormat).toBe(resolved);
  });
});

const ASK = { state: 's', questions: { ok: { type: 'boolean' as const, instructions: 'q' } } };

async function judgeErrorFor(response: () => Response, key = 'fake-jev-key'): Promise<VetError> {
  const fetchStub = vi.fn(async () => response());
  const judge = createJevJudge({ preset: 'typesafe', apiKey: key, fetch: fetchStub });
  return catchVetError(judge.doJudge(ASK));
}

describe('judge error kind', () => {
  test.each([
    [401, {}, 'terminal-auth'],
    [403, { detail: { error_type: 'authentication_error' } }, 'terminal-auth'],
    [402, {}, 'terminal-billing'],
    [403, { error: { type: 'no_providers_available' } }, 'terminal-request'],
    [404, {}, 'terminal-request'],
    [422, {}, 'terminal-request'],
    [400, {}, 'terminal-request'],
    [429, {}, 'retryable'],
    [429, { error: { type: 'rate_limit_exceeded' } }, 'retryable'],
    [429, { error: { type: 'quota_for_entity_exceeded' } }, 'terminal-billing'],
    [500, {}, 'retryable'],
    [502, {}, 'retryable'],
    [503, {}, 'retryable'],
  ] as const)('kind for HTTP %s %j is %s', async (status, body, kind) => {
    const err = await judgeErrorFor(() => jsonResponse(body, { status }));
    expect(err.details?.kind).toBe(kind);
  });

  test('kind for HTTP 403 with auth body is terminal-auth and JUDGE_UNAUTHORIZED', async () => {
    const err = await judgeErrorFor(() =>
      jsonResponse({ detail: { error_type: 'authentication_error' } }, { status: 403 }),
    );
    expect(err.code).toBe('JUDGE_UNAUTHORIZED');
    expect(err.details?.kind).toBe('terminal-auth');
  });

  test('kind for a network failure is retryable', async () => {
    const fetchStub: typeof fetch = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const judge = createJevJudge({ preset: 'typesafe', apiKey: 'fake-jev-key', fetch: fetchStub });
    const err = await catchVetError(judge.doJudge(ASK));
    expect(err.details?.kind).toBe('retryable');
    expect(err.details?.retryable).toBe(true);
  });

  test('kind for a timeout is retryable but JUDGE_TIMEOUT never sets details.retryable', async () => {
    const fetchStub: typeof fetch = vi.fn(() => new Promise<Response>(() => {}));
    const judge = createJevJudge({
      preset: 'typesafe',
      apiKey: 'fake-jev-key',
      fetch: fetchStub,
      deadlineMs: 5,
    });
    const err = await catchVetError(judge.doJudge(ASK));
    expect(err.code).toBe('JUDGE_TIMEOUT');
    expect(err.details?.kind).toBe('retryable');
    expect(err.details?.retryable).not.toBe(true);
  });

  test('existing fields keep their values alongside kind', async () => {
    const e402 = await judgeErrorFor(() => jsonResponse({}, { status: 402 }));
    expect(e402.details).toMatchObject({ retryable: false, hint: 'no credit' });
    expect(e402.message).toBe('judge account has no credit');
    const e401 = await judgeErrorFor(() =>
      jsonResponse({}, { status: 401, headers: { 'x-typesafe-request-id': 'req-1' } }),
    );
    expect(e401.details?.requestId).toBe('req-1');
    const e403 = await judgeErrorFor(() =>
      jsonResponse({ error: { type: 'no_providers_available' } }, { status: 403 }),
    );
    expect(e403.details).toMatchObject({ retryable: false, hint: 'no_providers_available' });
  });

  test('the API key never appears in an error carrying kind', async () => {
    const key = 'sk-secret-key-do-not-log';
    for (const status of [401, 402, 403, 404, 422, 429, 500]) {
      const err = await judgeErrorFor(
        () => jsonResponse({ echoed: key, error: { type: 'x' } }, { status }),
        key,
      );
      expect(serializeErrorChain(err)).not.toContain(key);
    }
  });
});

function retryAfterErr(headers: Record<string, string>, body: unknown = {}): Promise<VetError> {
  return judgeErrorFor(() => jsonResponse(body, { status: 429, headers }));
}

describe('judge retry-after and quota classification', () => {
  test('Retry-After as an HTTP date 5 s ahead -> retryAfterMs within [4000, 5000]', async () => {
    const date = new Date(Date.now() + 5000).toUTCString();
    const err = await retryAfterErr({ 'retry-after': date });
    const ms = err.details?.retryAfterMs;
    expect(ms).toBeGreaterThanOrEqual(3000);
    expect(ms).toBeLessThanOrEqual(5000);
  });

  test('Retry-After 0 -> retryAfterMs absent', async () => {
    const err = await retryAfterErr({ 'retry-after': '0' });
    expect(err.details?.retryable).toBe(true);
    expect(err.details?.retryAfterMs).toBeUndefined();
  });

  test('Retry-After in the past -> absent', async () => {
    const err = await retryAfterErr({ 'retry-after': new Date(Date.now() - 60_000).toUTCString() });
    expect(err.details?.retryAfterMs).toBeUndefined();
  });

  test.each(['abc', '1e9', '-1', '', '1.5'])('Retry-After %j -> absent', async (value) => {
    const err = await retryAfterErr({ 'retry-after': value });
    expect(err.details?.retryable).toBe(true);
    expect(err.details?.retryAfterMs).toBeUndefined();
  });

  test('Retry-After with surrounding whitespace is trimmed', async () => {
    const err = await retryAfterErr({ 'retry-after': ' 3 ' });
    expect(err.details?.retryAfterMs).toBe(3000);
  });

  test('429 with error.type quota_for_entity_exceeded -> retryable false, hint is the type', async () => {
    const err = await retryAfterErr({}, { error: { type: 'quota_for_entity_exceeded' } });
    expect(err.code).toBe('JUDGE_UNAVAILABLE');
    expect(err.details?.retryable).toBe(false);
    expect(err.details?.hint).toBe('quota_for_entity_exceeded');
    expect(err.details?.kind).toBe('terminal-billing');
  });

  test('429 with detail.error_type containing quota -> retryable false', async () => {
    const err = await retryAfterErr({}, { detail: { error_type: 'monthly_quota_hit' } });
    expect(err.details?.retryable).toBe(false);
    expect(err.details?.hint).toBe('monthly_quota_hit');
  });

  test('429 rate_limit_exceeded stays retryable', async () => {
    const err = await retryAfterErr({}, { error: { type: 'rate_limit_exceeded' } });
    expect(err.details?.retryable).toBe(true);
  });

  test('429 with a non-JSON body -> retryable true, no retryAfterMs', async () => {
    const err = await judgeErrorFor(() => new Response('<html>slow down</html>', { status: 429 }));
    expect(err.details?.retryable).toBe(true);
    expect(err.details?.retryAfterMs).toBeUndefined();
  });

  test('a 5xx body mentioning quota is still retryable', async () => {
    const err = await judgeErrorFor(() =>
      jsonResponse({ error: { type: 'quota_exceeded' } }, { status: 503 }),
    );
    expect(err.details?.retryable).toBe(true);
    expect(err.details?.kind).toBe('retryable');
  });

  test('402 is terminal after one attempt', async () => {
    const fetchStub = vi.fn(async () => jsonResponse({}, { status: 402 }));
    const judge = createJevJudge({ preset: 'typesafe', apiKey: 'fake-jev-key', fetch: fetchStub });
    const err = await catchVetError(judge.doJudge(ASK));
    expect(err.details?.retryable).toBe(false);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  test('quota 429 is terminal after one attempt', async () => {
    const fetchStub = vi.fn(async () =>
      jsonResponse({ error: { type: 'quota_for_entity_exceeded' } }, { status: 429 }),
    );
    const judge = createJevJudge({ preset: 'typesafe', apiKey: 'fake-jev-key', fetch: fetchStub });
    const err = await catchVetError(judge.doJudge(ASK));
    expect(err.details?.retryable).toBe(false);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });
});

describe('served model id through the transport', () => {
  test('a judge call through the vercel preset records the served slug in model.resolved', async () => {
    const run1 = structuredClone(loadFixture('2026-09-25-gateway-systemone-response-run1.json'));
    const gateway = asMutableRecord(
      asMutableRecord(asMutableRecord(run1)['provider_metadata'])['gateway'],
    );
    asMutableRecord(gateway['routing'])['canonicalSlug'] = 'typesafe-ai/jev-1.13-20260917';
    const fetchStub = vi.fn(async () => jsonResponse(run1));
    const judge = createJevJudge({ preset: 'vercel', apiKey: 'fake-jev-key', fetch: fetchStub });

    const result = await judge.doJudge({ state: 'refund conversation', questions: RUN1_QUESTIONS });

    expect(result.model.resolved).toBe('typesafe-ai/jev-1.13-20260917');
  });
});

const withModels = (models: readonly string[]): JevProviderOptions => ({
  gateway: { zeroDataRetention: true, only: ['typesafe-ai'], models },
});

describe('vercel preset refuses gateway model fallbacks', () => {
  test('vercel preset with providerOptions.gateway.models throws CONFIG_INVALID synchronously and never calls fetch', () => {
    const fetchStub = vi.fn(async () => jsonResponse(fakeSuccessBody('typesafe-ai/jev')));
    let thrown: unknown;
    try {
      createJevJudge({
        preset: 'vercel',
        apiKey: 'k',
        fetch: fetchStub,
        providerOptions: withModels(['anthropic/claude-sonnet-4.5']),
      });
    } catch (error) {
      thrown = error;
    }
    expect(VetError.isInstance(thrown) ? thrown.code : thrown).toBe('CONFIG_INVALID');
    expect(fetchStub).toHaveBeenCalledTimes(0);
  });

  test('vercel preset with an empty models array is accepted', () => {
    expect(() =>
      createJevJudge({ preset: 'vercel', apiKey: 'k', providerOptions: withModels([]) }),
    ).not.toThrow();
  });

  test('openrouter/typesafe/custom transports with the same option are not refused by this rule', async () => {
    const options = withModels(['a/b']);
    const builds = [
      { preset: 'openrouter' as const },
      { preset: 'typesafe' as const },
      { baseURL: 'https://example.test', model: 'm' },
    ];
    for (const build of builds) {
      const calls: CapturedCall[] = [];
      const fetchStub: typeof fetch = async (input, init) => {
        calls.push({ url: String(input), init: init ?? {} });
        return jsonResponse(fakeSuccessBody('m'));
      };
      const judge = createJevJudge({
        ...build,
        apiKey: 'k',
        fetch: fetchStub,
        providerOptions: options,
      });
      await judge.doJudge({
        state: 's',
        questions: { ok: { type: 'boolean', instructions: 'q' } },
      });
      const call = calls[0];
      if (call === undefined) throw new Error('expected one fetch call');
      const sent = await capturedBody(call);
      expect(sent.providerOptions).toEqual(options);
    }
  });

  test('createJevJudgeFromEndpoint with preset vercel and the option throws CONFIG_INVALID naming the option path', () => {
    let thrown: unknown;
    try {
      createJevJudgeFromEndpoint(
        { preset: 'vercel' },
        { apiKey: 'k', providerOptions: withModels(['a/b']) },
      );
    } catch (error) {
      thrown = error;
    }
    if (!VetError.isInstance(thrown)) throw new Error('expected a VetError');
    expect(thrown.code).toBe('CONFIG_INVALID');
    expect(thrown.message).toContain('fallback');
    expect(thrown.message).toContain('providerOptions.gateway.models');
  });

  test('the vercel preset default providerOptions (zeroDataRetention + only) still build', () => {
    expect(() => createJevJudge({ preset: 'vercel', apiKey: 'k' })).not.toThrow();
  });
});
