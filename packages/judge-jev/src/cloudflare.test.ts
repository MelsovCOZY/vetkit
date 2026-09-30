import { describe, expect, test, vi } from 'vitest';
import { VetError } from '@vetkit/spec';
import { createJevJudge } from './transport.ts';

interface CapturedCall {
  readonly url: string;
  readonly init: RequestInit;
}

interface CapturedBody {
  readonly state: string;
  readonly questions: Record<string, unknown>;
}

const ACCOUNT_ID = 'acc123';
const TOKEN = 'fake-cf-token-should-never-leak';
const RUN_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/run/typesafe/jev`;
const QUESTIONS = { ok: { type: 'boolean', instructions: 'q?' } } as const;

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

// Request#json() rebuilds the sent body without the raw JSON parse call banned
// under packages/*/src (scripts/ban-raw-json-parse.sh).
async function capturedBody(call: CapturedCall): Promise<CapturedBody> {
  return new Request(call.url, call.init).json();
}

function stubFetch(response: () => Response): { fetch: typeof fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fetchStub: typeof fetch = vi.fn(async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return response();
  });
  return { fetch: fetchStub, calls };
}

function cloudflareJudge(fetchStub: typeof fetch, deadlineMs?: number) {
  return createJevJudge({
    preset: 'cloudflare',
    accountId: ACCOUNT_ID,
    apiKey: TOKEN,
    fetch: fetchStub,
    ...(deadlineMs !== undefined ? { deadlineMs } : {}),
  });
}

async function catchVetError(promise: Promise<unknown>): Promise<VetError> {
  try {
    await promise;
  } catch (err) {
    if (VetError.isInstance(err)) return err;
    throw err;
  }
  throw new Error('expected doJudge() to reject');
}

function envelope(result: unknown): unknown {
  return { result, success: true, errors: [], messages: [] };
}

describe('cloudflare preset request', () => {
  test('POSTs {state, questions} in the TypeSafe question shape to the account run URL with a Bearer token', async () => {
    const { fetch: fetchStub, calls } = stubFetch(() =>
      jsonResponse(envelope({ answers: { ok: { type: 'noul', noul: 0.8 } } })),
    );

    await cloudflareJudge(fetchStub).doJudge({ state: 'hello', questions: QUESTIONS });

    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (call === undefined) throw new Error('fetch was not called');
    expect(call.url).toBe(RUN_URL);
    expect(call.init.method).toBe('POST');
    expect(new Headers(call.init.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
    const body = await capturedBody(call);
    expect(body.state).toBe('hello');
    expect(body.questions).toEqual({ ok: { type: 'noul', instructions: 'q?' } });
    expect('model' in body).toBe(false);
    expect('providerOptions' in body).toBe(false);
  });

  test('capabilities report transport "cloudflare" and pinned:false', () => {
    const judge = cloudflareJudge(stubFetch(() => jsonResponse({})).fetch);
    expect(judge.capabilities.transport).toBe('cloudflare');
    expect(judge.capabilities.pinned).toBe(false);
  });
});

describe('cloudflare envelope unwrap', () => {
  test('unwraps result and reports model {requested, resolved from result.model, transport, pinned:false}', async () => {
    const { fetch: fetchStub } = stubFetch(() =>
      jsonResponse(
        envelope({
          model: 'typesafe/jev-served',
          answers: { ok: { type: 'noul', noul: 0.8 } },
          usage: { input_tokens: 7, output_tokens: 3 },
        }),
      ),
    );

    const res = await cloudflareJudge(fetchStub).doJudge({ state: 's', questions: QUESTIONS });

    expect(res.answers.ok).toEqual({ type: 'boolean', probability: 0.8 });
    expect(res.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
    expect(res.model).toMatchObject({
      requested: 'typesafe/jev',
      resolved: 'typesafe/jev-served',
      transport: 'cloudflare',
      pinned: false,
    });
  });

  test('resolved falls back to "typesafe/jev" and absent usage becomes zeros', async () => {
    const { fetch: fetchStub } = stubFetch(() =>
      jsonResponse(envelope({ answers: { ok: { type: 'noul', noul: 0.1 } } })),
    );

    const res = await cloudflareJudge(fetchStub).doJudge({ state: 's', questions: QUESTIONS });

    expect(res.model.resolved).toBe('typesafe/jev');
    expect(res.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  test('success:false becomes JUDGE_BAD_RESPONSE listing every errors[].message', async () => {
    const { fetch: fetchStub } = stubFetch(() =>
      jsonResponse({
        result: null,
        success: false,
        errors: [
          { code: 5006, message: 'Invalid input' },
          { code: 7000, message: 'No route for that URI' },
        ],
        messages: [],
      }),
    );

    const err = await catchVetError(
      cloudflareJudge(fetchStub).doJudge({ state: 's', questions: QUESTIONS }),
    );

    expect(err.code).toBe('JUDGE_BAD_RESPONSE');
    expect(err.message).toContain('Invalid input');
    expect(err.message).toContain('No route for that URI');
  });

  test.each([
    ['null', null],
    ['an empty object', {}],
  ])('success:true with %s result becomes JUDGE_BAD_RESPONSE', async (_label, result) => {
    const { fetch: fetchStub } = stubFetch(() => jsonResponse(envelope(result)));

    const err = await catchVetError(
      cloudflareJudge(fetchStub).doJudge({ state: 's', questions: QUESTIONS }),
    );

    expect(err.code).toBe('JUDGE_BAD_RESPONSE');
  });
});

describe('cloudflare errors', () => {
  test('HTTP 403 maps to JUDGE_UNAVAILABLE retryable:false naming the token env var, never its value', async () => {
    const { fetch: fetchStub } = stubFetch(() =>
      jsonResponse(
        { result: null, success: false, errors: [{ code: 10000, message: `bad ${TOKEN}` }] },
        { status: 403 },
      ),
    );

    const err = await catchVetError(
      cloudflareJudge(fetchStub).doJudge({ state: 's', questions: QUESTIONS }),
    );

    expect(err.code).toBe('JUDGE_UNAVAILABLE');
    expect(err.details).toMatchObject({ retryable: false });
    expect(err.message).toContain('CLOUDFLARE_API_TOKEN');
    expect(err.message).not.toContain(TOKEN);
    expect(JSON.stringify(err.cause ?? null)).not.toContain(TOKEN);
  });

  test('cloudflare 403 is terminal-auth', async () => {
    const { fetch: fetchStub } = stubFetch(() => jsonResponse({}, { status: 403 }));

    const err = await catchVetError(
      cloudflareJudge(fetchStub).doJudge({ state: 's', questions: QUESTIONS }),
    );

    expect(err.details).toMatchObject({ kind: 'terminal-auth', retryable: false });
  });

  test('a custom apiKeyEnv is the name reported on 403', async () => {
    const { fetch: fetchStub } = stubFetch(() => jsonResponse({}, { status: 403 }));
    const judge = createJevJudge({
      preset: 'cloudflare',
      accountId: ACCOUNT_ID,
      apiKeyEnv: 'MY_CF_TOKEN',
      apiKey: TOKEN,
      fetch: fetchStub,
    });

    const err = await catchVetError(judge.doJudge({ state: 's', questions: QUESTIONS }));

    expect(err.message).toContain('MY_CF_TOKEN');
  });

  test('the shared deadline applies: a hung fetch rejects with JUDGE_TIMEOUT', async () => {
    const fetchStub: typeof fetch = vi.fn(() => new Promise<Response>(() => {}));

    await expect(
      cloudflareJudge(fetchStub, 20).doJudge({ state: 's', questions: QUESTIONS }),
    ).rejects.toMatchObject({ code: 'JUDGE_TIMEOUT' });
  });

  test('missing accountId throws CONFIG_INVALID before any fetch', () => {
    const fetchStub: typeof fetch = vi.fn();

    expect(() =>
      // @ts-expect-error accountId is required for the cloudflare preset
      createJevJudge({ preset: 'cloudflare', apiKey: TOKEN, fetch: fetchStub }),
    ).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
    expect(() =>
      createJevJudge({ preset: 'cloudflare', accountId: '', apiKey: TOKEN, fetch: fetchStub }),
    ).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
    expect(fetchStub).not.toHaveBeenCalled();
  });
});
