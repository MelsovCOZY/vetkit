import { describe, expect, test, vi } from 'vitest';
import { parseAdapterId, VetError, type JsonSchema } from '@vetkit/spec';
import {
  createOpenAICompatibleGenerator,
  type OpenAICompatibleGeneratorOptions,
} from './generator.ts';

const KEY = 'sk-test-SECRET-1234567890';
const BASE = 'https://llm.example.test/v1';

interface CapturedCall {
  readonly url: string;
  readonly init: RequestInit;
}

interface SentBody {
  readonly model: string;
  readonly messages: ReadonlyArray<{ role: string; content: string }>;
  readonly temperature?: number;
  readonly response_format?: {
    type: string;
    json_schema?: { name: string; schema: JsonSchema; strict: boolean };
  };
  readonly [extra: string]: unknown;
}

// Request#json() rebuilds the sent body without the raw JSON parse banned under src.
async function sentBody(call: CapturedCall): Promise<SentBody> {
  return new Request(call.url, call.init).json();
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function completion(content: unknown, extra: Record<string, unknown> = {}): unknown {
  return {
    model: 'served-model-2026',
    choices: [{ index: 0, message: { role: 'assistant', content } }],
    ...extra,
  };
}

function stubFetch(...responses: Array<Response | (() => Promise<Response>)>): {
  fetch: typeof fetch;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  let i = 0;
  const impl = vi.fn((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init: init ?? {} });
    const next = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (next === undefined) return Promise.reject(new Error('no stub response'));
    return typeof next === 'function' ? next() : Promise.resolve(next);
  });
  return { fetch: impl, calls };
}

function make(
  fetchImpl: typeof fetch,
  extra: Partial<OpenAICompatibleGeneratorOptions> = {},
): ReturnType<typeof createOpenAICompatibleGenerator> {
  return createOpenAICompatibleGenerator({
    baseURL: BASE,
    apiKey: KEY,
    model: 'my-model',
    structured: 'json_schema',
    fetch: fetchImpl,
    ...extra,
  });
}

async function rejection(p: Promise<unknown>): Promise<VetError> {
  try {
    await p;
  } catch (err) {
    if (VetError.isInstance(err)) return err;
    throw err;
  }
  throw new Error('expected a rejection');
}

function serialiseChain(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let guard = 0; current !== undefined && current !== null && guard < 10; guard += 1) {
    if (current instanceof Error) {
      parts.push(current.message);
      if (VetError.isInstance(current)) parts.push(JSON.stringify(current.details ?? null));
      current = current.cause;
    } else {
      parts.push(JSON.stringify(current));
      current = undefined;
    }
  }
  return parts.join('\n');
}

const person: JsonSchema = {
  type: 'object',
  properties: { name: { type: 'string' }, age: { type: 'integer' } },
  required: ['name'],
};

const schemaReq = { prompt: 'describe', schema: { name: 'person', jsonSchema: person } };

describe('createOpenAICompatibleGenerator', () => {
  test('adapter id is openai-compatible/chat-completions and parses as an adapter id', () => {
    const gen = make(stubFetch().fetch);
    expect(gen.id).toBe('openai-compatible/chat-completions');
    expect(() => parseAdapterId(gen.id)).not.toThrow();
    expect(gen.specVersion).toBe('v1');
    expect(gen.capabilities).toEqual({ structured: 'json_schema', streaming: false });
  });

  test('empty apiKey is CONFIG_INVALID', () => {
    let caught: unknown;
    try {
      createOpenAICompatibleGenerator({
        baseURL: BASE,
        apiKey: '',
        model: 'm',
        structured: 'prompt',
      });
    } catch (err) {
      caught = err;
    }
    expect(VetError.isInstance(caught) && caught.code).toBe('CONFIG_INVALID');
  });

  test('posts response_format json_schema strict to <baseURL>/chat/completions', async () => {
    const { fetch, calls } = stubFetch(jsonResponse(completion('{"name":"Ada"}')));
    await make(fetch, { baseURL: `${BASE}/` }).doGenerate({ ...schemaReq, system: 'be terse' });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (call === undefined) throw new Error('no call');
    expect(call.url).toBe(`${BASE}/chat/completions`);
    expect(call.init.method).toBe('POST');
    const headers = new Headers(call.init.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(headers.get('content-type')).toBe('application/json');
    const body = await sentBody(call);
    expect(body.model).toBe('my-model');
    expect(body.messages).toEqual([
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'describe' },
    ]);
    expect(body.response_format?.type).toBe('json_schema');
    expect(body.response_format?.json_schema?.name).toBe('person');
    expect(body.response_format?.json_schema?.strict).toBe(true);
  });

  test('normalised schema is what is sent on the wire', async () => {
    const { fetch, calls } = stubFetch(jsonResponse(completion('{"name":"Ada"}')));
    await make(fetch).doGenerate(schemaReq);
    const call = calls[0];
    if (call === undefined) throw new Error('no call');
    const body = await sentBody(call);
    expect(body.response_format?.json_schema?.schema).toEqual({
      type: 'object',
      properties: { name: { type: 'string' }, age: { type: ['integer', 'null'] } },
      required: ['name', 'age'],
      additionalProperties: false,
    });
  });

  test('returns the validated value', async () => {
    const { fetch } = stubFetch(
      jsonResponse(
        completion('{"name":"Ada","age":null}', {
          usage: { prompt_tokens: 12, completion_tokens: 7 },
        }),
      ),
    );
    const out = await make(fetch).doGenerate(schemaReq);
    expect(out.value).toEqual({ name: 'Ada' });
    expect(out.text).toBe('{"name":"Ada","age":null}');
    expect(out.usage).toEqual({ inputTokens: 12, outputTokens: 7 });
    expect(out.resolvedModelId).toBe('served-model-2026');
  });

  test('strips json fences', async () => {
    const { fetch } = stubFetch(jsonResponse(completion('```json\n{"name":"Ada","age":3}\n```')));
    const out = await make(fetch).doGenerate(schemaReq);
    expect(out.value).toEqual({ name: 'Ada', age: 3 });
  });

  test('invalid body retries once then GENERATOR_BAD_OUTPUT with issues', async () => {
    const { fetch, calls } = stubFetch(
      jsonResponse(completion('{"name":42}')),
      jsonResponse(completion('{"name":43}')),
    );
    const err = await rejection(make(fetch).doGenerate(schemaReq));
    expect(calls).toHaveLength(2);
    expect(err.code).toBe('GENERATOR_BAD_OUTPUT');
    expect(serialiseChain(err)).toContain('/name');
  });

  test('retry prompt carries validation issues', async () => {
    const { fetch, calls } = stubFetch(
      jsonResponse(completion('{"name":42}')),
      jsonResponse(completion('{"name":"Ada"}')),
    );
    const out = await make(fetch).doGenerate(schemaReq);
    expect(out.value).toEqual({ name: 'Ada' });
    const retry = calls[1];
    if (retry === undefined) throw new Error('no retry');
    const body = await sentBody(retry);
    const user = body.messages.at(-1)?.content ?? '';
    expect(user.startsWith('describe')).toBe(true);
    expect(user).toContain('Your previous reply was invalid');
    expect(user).toContain('/name');
  });

  test('json_object + schema is GENERATOR_CAPABILITY before I/O', async () => {
    const { fetch } = stubFetch(jsonResponse(completion('{}')));
    const err = await rejection(make(fetch, { structured: 'json_object' }).doGenerate(schemaReq));
    expect(err.code).toBe('GENERATOR_CAPABILITY');
    expect(fetch).not.toHaveBeenCalled();
  });

  test('prompt + schema is GENERATOR_CAPABILITY before I/O', async () => {
    const { fetch } = stubFetch(jsonResponse(completion('{}')));
    const err = await rejection(make(fetch, { structured: 'prompt' }).doGenerate(schemaReq));
    expect(err.code).toBe('GENERATOR_CAPABILITY');
    expect(fetch).not.toHaveBeenCalled();
  });

  test('no schema returns text', async () => {
    const { fetch, calls } = stubFetch(jsonResponse(completion('hello there')));
    const out = await make(fetch, { structured: 'prompt' }).doGenerate({ prompt: 'hi' });
    expect(out.text).toBe('hello there');
    expect(out.value).toBeUndefined();
    const call = calls[0];
    if (call === undefined) throw new Error('no call');
    expect((await sentBody(call)).response_format).toBeUndefined();
  });

  test('json_object mode sends response_format json_object and does not parse', async () => {
    const { fetch, calls } = stubFetch(jsonResponse(completion('not json at all')));
    const out = await make(fetch, { structured: 'json_object' }).doGenerate({ prompt: 'hi' });
    expect(out.text).toBe('not json at all');
    expect(out.value).toBeUndefined();
    const call = calls[0];
    if (call === undefined) throw new Error('no call');
    expect((await sentBody(call)).response_format).toEqual({ type: 'json_object' });
  });

  test('extraBody is sent but cannot override model or messages', async () => {
    const { fetch, calls } = stubFetch(jsonResponse(completion('ok')));
    await make(fetch, {
      temperature: 0,
      extraBody: { provider: { require_parameters: true }, model: 'evil', messages: [] },
    }).doGenerate({ prompt: 'hi' });
    const call = calls[0];
    if (call === undefined) throw new Error('no call');
    const body = await sentBody(call);
    expect(body['provider']).toEqual({ require_parameters: true });
    expect(body.model).toBe('my-model');
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(body.temperature).toBe(0);
  });

  test('recursive $ref schema is GENERATOR_CAPABILITY naming $ref', async () => {
    const { fetch } = stubFetch(jsonResponse(completion('{}')));
    const err = await rejection(
      make(fetch).doGenerate({
        prompt: 'p',
        schema: {
          name: 'tree',
          jsonSchema: {
            type: 'object',
            properties: { child: { $ref: '#' } },
            required: ['child'],
          },
        },
      }),
    );
    expect(err.code).toBe('GENERATOR_CAPABILITY');
    expect(err.message).toContain('$ref');
    expect(fetch).not.toHaveBeenCalled();
  });

  test('invalid schema name fails before I/O', async () => {
    const { fetch } = stubFetch(jsonResponse(completion('{}')));
    const err = await rejection(
      make(fetch).doGenerate({ prompt: 'p', schema: { name: 'has space!', jsonSchema: person } }),
    );
    expect(err.code).toBe('GENERATOR_CAPABILITY');
    expect(fetch).not.toHaveBeenCalled();
  });

  test('uncompilable schema fails before I/O', async () => {
    const { fetch } = stubFetch(jsonResponse(completion('{}')));
    const err = await rejection(
      make(fetch).doGenerate({
        prompt: 'p',
        schema: {
          name: 'bad',
          jsonSchema: { type: 'object', properties: { a: { type: 'nope' } } },
        },
      }),
    );
    expect(err.code).toBe('E_SCHEMA_INVALID');
    expect(fetch).not.toHaveBeenCalled();
  });

  test('deadline aborts a hanging fetch and yields GENERATOR_UNAVAILABLE timeout', async () => {
    const { fetch } = stubFetch(() => new Promise<Response>(() => {}));
    const err = await rejection(make(fetch, { deadlineMs: 20 }).doGenerate({ prompt: 'p' }));
    expect(err.code).toBe('GENERATOR_UNAVAILABLE');
    expect(err.details?.hint).toBe('timeout');
    expect(err.details?.retryable).toBe(true);
  });

  test('hanging response body still yields GENERATOR_UNAVAILABLE timeout', async () => {
    const hanging = new Response('{}', { status: 200 });
    vi.spyOn(hanging, 'json').mockReturnValue(new Promise(() => {}));
    const { fetch } = stubFetch(hanging);
    const err = await rejection(make(fetch, { deadlineMs: 20 }).doGenerate({ prompt: 'p' }));
    expect(err.code).toBe('GENERATOR_UNAVAILABLE');
    expect(err.details?.hint).toBe('timeout');
  });

  test('caller signal abort yields GENERATOR_UNAVAILABLE', async () => {
    const { fetch } = stubFetch(() => new Promise<Response>(() => {}));
    const controller = new AbortController();
    const pending = make(fetch, { deadlineMs: 60_000 }).doGenerate({
      prompt: 'p',
      signal: controller.signal,
    });
    controller.abort();
    const err = await rejection(pending);
    expect(err.code).toBe('GENERATOR_UNAVAILABLE');
    expect(err.details?.hint).toBe('aborted');
  });

  test('network failure is GENERATOR_UNAVAILABLE network, retryable', async () => {
    const { fetch } = stubFetch(() => Promise.reject(new TypeError('fetch failed')));
    const err = await rejection(make(fetch).doGenerate({ prompt: 'p' }));
    expect(err.code).toBe('GENERATOR_UNAVAILABLE');
    expect(err.details).toMatchObject({ hint: 'network', retryable: true });
  });

  test('key in a network error message is redacted', async () => {
    const { fetch } = stubFetch(() =>
      Promise.reject(new Error(`connect failed for Bearer ${KEY}`, { cause: `raw ${KEY}` })),
    );
    const err = await rejection(make(fetch).doGenerate({ prompt: 'p' }));
    const chain = serialiseChain(err);
    expect(chain).not.toContain(KEY);
    expect(chain).toContain('[REDACTED]');
  });

  test('key echoed in error body never appears in message or cause', async () => {
    const { fetch } = stubFetch(
      jsonResponse({ error: { message: `bad key ${KEY}` } }, { status: 401 }),
    );
    const err = await rejection(make(fetch).doGenerate({ prompt: 'p' }));
    const chain = serialiseChain(err);
    expect(chain).not.toContain(KEY);
    expect(chain).toContain('[REDACTED]');
  });

  test('402 names the env var, retryable false', async () => {
    const { fetch } = stubFetch(jsonResponse({ error: 'no credit' }, { status: 402 }));
    const err = await rejection(
      make(fetch, { apiKeyEnv: 'MY_LLM_KEY' }).doGenerate({ prompt: 'p' }),
    );
    expect(err.code).toBe('GENERATOR_UNAVAILABLE');
    expect(err.details?.retryable).toBe(false);
    expect(err.message).toContain('MY_LLM_KEY');
  });

  test('403 likewise', async () => {
    const { fetch } = stubFetch(jsonResponse({ error: 'forbidden' }, { status: 403 }));
    const err = await rejection(
      make(fetch, { apiKeyEnv: 'MY_LLM_KEY' }).doGenerate({ prompt: 'p' }),
    );
    expect(err.code).toBe('GENERATOR_UNAVAILABLE');
    expect(err.details?.retryable).toBe(false);
    expect(err.message).toContain('MY_LLM_KEY');
  });

  test('401 without apiKeyEnv names the generator API key', async () => {
    const { fetch } = stubFetch(jsonResponse({}, { status: 401 }));
    const err = await rejection(make(fetch).doGenerate({ prompt: 'p' }));
    expect(err.message).toContain('the generator API key');
  });

  test('429 carries retryAfterMs', async () => {
    const { fetch } = stubFetch(
      jsonResponse({ error: 'slow down' }, { status: 429, headers: { 'retry-after': '3' } }),
    );
    const err = await rejection(make(fetch).doGenerate({ prompt: 'p' }));
    expect(err.code).toBe('GENERATOR_UNAVAILABLE');
    expect(err.details).toMatchObject({ retryable: true, retryAfterMs: 3000 });
  });

  test('503 is GENERATOR_UNAVAILABLE retryable', async () => {
    const { fetch } = stubFetch(jsonResponse({}, { status: 503 }));
    const err = await rejection(make(fetch).doGenerate({ prompt: 'p' }));
    expect(err.code).toBe('GENERATOR_UNAVAILABLE');
    expect(err.details?.retryable).toBe(true);
  });

  test('400 is GENERATOR_UNAVAILABLE non-retryable, not retried', async () => {
    const { fetch, calls } = stubFetch(
      jsonResponse({ error: 'response_format unsupported' }, { status: 400 }),
    );
    const err = await rejection(make(fetch).doGenerate(schemaReq));
    expect(calls).toHaveLength(1);
    expect(err.code).toBe('GENERATOR_UNAVAILABLE');
    expect(err.details).toMatchObject({ retryable: false, hint: 'request_rejected' });
    expect(err.message).toContain('my-model');
    expect(serialiseChain(err)).toContain('response_format unsupported');
  });

  test('200 with empty choices is GENERATOR_BAD_OUTPUT', async () => {
    const { fetch, calls } = stubFetch(jsonResponse({ model: 'x', choices: [] }));
    const err = await rejection(make(fetch).doGenerate(schemaReq));
    expect(err.code).toBe('GENERATOR_BAD_OUTPUT');
    expect(calls).toHaveLength(1);
  });

  test('non-string content is GENERATOR_BAD_OUTPUT', async () => {
    const { fetch } = stubFetch(jsonResponse(completion(null)));
    const err = await rejection(make(fetch).doGenerate({ prompt: 'p' }));
    expect(err.code).toBe('GENERATOR_BAD_OUTPUT');
  });

  test('refusal is GENERATOR_BAD_OUTPUT', async () => {
    const { fetch, calls } = stubFetch(
      jsonResponse({
        choices: [{ message: { role: 'assistant', content: null, refusal: 'I cannot help' } }],
      }),
    );
    const err = await rejection(make(fetch).doGenerate(schemaReq));
    expect(err.code).toBe('GENERATOR_BAD_OUTPUT');
    expect(err.details?.hint).toBe('refusal');
    expect(calls).toHaveLength(1);
  });

  test('non-JSON response body is GENERATOR_BAD_OUTPUT', async () => {
    const { fetch } = stubFetch(new Response('<html>oops</html>', { status: 200 }));
    const err = await rejection(make(fetch).doGenerate({ prompt: 'p' }));
    expect(err.code).toBe('GENERATOR_BAD_OUTPUT');
  });

  test('missing usage yields undefined not zeros', async () => {
    const { fetch } = stubFetch(jsonResponse(completion('hi')));
    const out = await make(fetch).doGenerate({ prompt: 'p' });
    expect(out.usage).toBeUndefined();
    expect('usage' in out).toBe(false);
  });

  test('partial usage maps only numeric fields', async () => {
    const { fetch } = stubFetch(jsonResponse(completion('hi', { usage: { prompt_tokens: 4 } })));
    const out = await make(fetch).doGenerate({ prompt: 'p' });
    expect(out.usage).toEqual({ inputTokens: 4 });
  });
});
