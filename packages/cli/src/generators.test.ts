import { readFile } from 'node:fs/promises';
import { describe, expect, test, vi } from 'vitest';
import { VetError, type GeneratorEndpoint } from '@vetkit/spec';
import { generatorFromEndpoint } from './generators.ts';

const ENV = { MY_GEN_KEY: 'sk-test-value' };

const ep: GeneratorEndpoint = {
  kind: 'openai-compatible',
  baseURL: 'https://gen.example/v1',
  apiKeyEnv: 'MY_GEN_KEY',
  model: 'gen-model',
};

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

function stubFetch(): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = vi.fn((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init: init ?? {} });
    const body = {
      model: 'served-model',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hello' } }],
    };
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
  return { fetch: impl, calls };
}

function thrown(fn: () => unknown): VetError {
  try {
    fn();
  } catch (error) {
    if (VetError.isInstance(error)) return error;
    throw error;
  }
  throw new Error('expected a VetError');
}

function header(init: RequestInit, name: string): string | null {
  return new Headers(init.headers).get(name);
}

describe('generatorFromEndpoint', () => {
  test('builds a GeneratorV1 from an openai-compatible endpoint, key read by name', async () => {
    const { fetch, calls } = stubFetch();
    const gen = generatorFromEndpoint(ep, { env: ENV, fetch });
    expect(gen.specVersion).toBe('v1');
    expect(gen.id).toBeTruthy();
    expect(gen.capabilities.structured).toBe('json_schema');
    await gen.doGenerate({ prompt: 'say hello' });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe('https://gen.example/v1/chat/completions');
    expect(call && header(call.init, 'authorization')).toBe('Bearer sk-test-value');
  });

  test('honours structured json_object / prompt', () => {
    const { fetch } = stubFetch();
    for (const structured of ['json_object', 'prompt'] as const) {
      const gen = generatorFromEndpoint({ ...ep, structured }, { env: ENV, fetch });
      expect(gen.capabilities.structured).toBe(structured);
    }
  });

  test('unset apiKeyEnv rejects CONFIG_INVALID naming the var', () => {
    const { fetch } = stubFetch();
    const error = thrown(() => generatorFromEndpoint(ep, { env: {}, fetch }));
    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.message).toContain('MY_GEN_KEY');
    expect(fetch).not.toHaveBeenCalled();
  });

  test('empty apiKeyEnv value rejects CONFIG_INVALID', () => {
    const { fetch } = stubFetch();
    const error = thrown(() => generatorFromEndpoint(ep, { env: { MY_GEN_KEY: '' }, fetch }));
    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.message).toContain('MY_GEN_KEY');
    expect(fetch).not.toHaveBeenCalled();
  });

  test('unknown kind rejects CONFIG_INVALID before reading env', () => {
    const { fetch } = stubFetch();
    const env = new Proxy<Record<string, string | undefined>>(
      {},
      {
        get: () => {
          throw new Error('env was read');
        },
      },
    );
    const error = thrown(() =>
      generatorFromEndpoint({ ...ep, kind: 'smoke-signal' }, { env, fetch }),
    );
    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.message).toContain('smoke-signal');
    expect(fetch).not.toHaveBeenCalled();
  });

  test('endpoint without baseURL/model throws CONFIG_INVALID before reading env', () => {
    const { fetch } = stubFetch();
    const env = new Proxy<Record<string, string | undefined>>(
      {},
      {
        get: () => {
          throw new Error('env was read');
        },
      },
    );
    // The registry path: a string generator resolved through the registry comes back
    // judgeEndpoint-shaped ({kind, apiKeyEnv, preset}) and core casts it to GeneratorEndpoint.
    const registryEntry: unknown = {
      kind: 'openai-compatible',
      apiKeyEnv: 'MY_GEN_KEY',
      preset: 'p',
    };
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const registryShaped = registryEntry as GeneratorEndpoint;
    const error = thrown(() => generatorFromEndpoint(registryShaped, { env, fetch }));
    expect(error.code).toBe('CONFIG_INVALID');
    expect(fetch).not.toHaveBeenCalled();
  });

  test('generators.ts names no vendor outside comments', async () => {
    const source = await readFile(new URL('generators.ts', import.meta.url), 'utf8');
    const code = source.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/\/\/.*$/gm, '');
    expect(code.match(/vercel|openrouter|cloudflare/gi) ?? []).toHaveLength(0);
  });
});
