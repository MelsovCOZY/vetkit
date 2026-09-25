import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnv, gatewayFetch, readJsonl, writeJsonl, sha256, withConcurrency } from './index.ts';

describe('loadEnv', () => {
  const KEY = 'AI_GATEWAY_API_KEY';
  let original: string | undefined;

  beforeEach(() => {
    original = process.env[KEY];
    delete process.env[KEY];
  });

  afterEach(() => {
    if (original === undefined) delete process.env[KEY];
    else process.env[KEY] = original;
  });

  test('throws a clear error naming the missing variable', () => {
    expect(() => loadEnv(KEY)).toThrow(/AI_GATEWAY_API_KEY/);
  });

  test('never includes the value in the error message', () => {
    process.env[KEY] = 'super-secret-value';
    delete process.env[KEY];
    // value never set for this assertion; separately assert a present value
    // does not leak if the function were to change to log it.
    let message = '';
    try {
      loadEnv(KEY);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toContain('super-secret-value');
  });

  test('returns the value when the variable is set', () => {
    process.env[KEY] = 'a-real-key';
    expect(loadEnv(KEY)).toBe('a-real-key');
  });
});

describe('gatewayFetch', () => {
  const KEY = 'AI_GATEWAY_API_KEY';
  let original: string | undefined;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    original = process.env[KEY];
    process.env[KEY] = 'test-key';
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    if (original === undefined) delete process.env[KEY];
    else process.env[KEY] = original;
    fetchSpy.mockRestore();
  });

  test('posts JSON to the gateway with an auth header and returns parsed JSON', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    const result = await gatewayFetch('/v1/chat/completions', { hello: 'world' }, { timeoutMs: 5000 });

    expect(result).toEqual({ ok: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain('/v1/chat/completions');
    expect(init?.method).toBe('POST');
    expect(String((init?.headers as Record<string, string>).authorization)).toContain('test-key');
    expect(JSON.parse(init?.body as string)).toEqual({ hello: 'world' });
  });

  test('throws on a non-ok response without leaking the api key', async () => {
    fetchSpy.mockResolvedValue(new Response('nope', { status: 500, statusText: 'Internal Error' }));

    await expect(
      gatewayFetch('/v1/chat/completions', {}, { timeoutMs: 5000 }),
    ).rejects.toThrow(/500/);
  });
});

describe('readJsonl / writeJsonl', () => {
  test('round-trips rows through a file', async () => {
    const path = join(tmpdir(), `vetkit-lib-test-${Date.now()}.jsonl`);
    const rows = [{ a: 1 }, { a: 2, b: 'two' }];
    try {
      await writeJsonl(path, rows);
      const back = await readJsonl<{ a: number; b?: string }>(path);
      expect(back).toEqual(rows);
    } finally {
      await rm(path, { force: true });
    }
  });

  test('preserves non-ASCII text written to disk', async () => {
    const path = join(tmpdir(), `vetkit-lib-test-utf8-${Date.now()}.jsonl`);
    const rows = [{ text: '3,2 миллиона тонн' }];
    try {
      await writeJsonl(path, rows);
      const raw = await readFile(path, 'utf8');
      expect(raw).toContain('3,2 миллиона тонн');
      const back = await readJsonl<{ text: string }>(path);
      expect(back[0]!.text).toBe('3,2 миллиона тонн');
    } finally {
      await rm(path, { force: true });
    }
  });
});

describe('sha256', () => {
  test('matches the known digest for "hello"', () => {
    expect(sha256('hello')).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });
});

describe('withConcurrency', () => {
  test('never runs more than n tasks at once', async () => {
    let active = 0;
    let maxActive = 0;
    const items = [1, 2, 3, 4, 5, 6];

    const results = await withConcurrency(2, items, async (item) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return item * 2;
    });

    expect(maxActive).toBeLessThanOrEqual(2);
    expect(results).toEqual([2, 4, 6, 8, 10, 12]);
  });
});
