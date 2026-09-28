// Unit tests for declarative sink descriptors (mol-yxn.13, OPEN-9 DECISION): resolveSinks
// builds @vetkit/sink-otel / @vetkit/sink-langfuse adapters from a `{kind,*Env}` descriptor,
// reading the named env vars. Network is always stubbed via the `fetch` option; nothing here
// makes a live call. The exact-id/prefix matching tests for plain adapter-object refs already
// live in commands/run-sinks.test.ts; this file covers only the descriptor-specific surface.
import { Writable } from 'node:stream';
import { describe, expect, test } from 'vitest';
import { VetError, type Verdict } from '@vetkit/spec';
import { handleError, type HandleErrorContext } from './errors.ts';
import { resolveSinks, sinkRefName } from './sinks.ts';

const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';

function verdict(overrides: Partial<Verdict> = {}): Verdict {
  return {
    id: 'v-1',
    caseId: 'case-1',
    criterionId: 'promised_refund',
    status: 'ok',
    answer: { type: 'boolean', probability: 0.9 },
    pass: true,
    threshold: 0.5,
    model: { requested: 'judge', resolved: 'judge-2026', transport: 'test', pinned: false },
    cacheHit: false,
    provenance: { traceId: TRACE_ID },
    ...overrides,
  };
}

interface Captured {
  readonly url: string;
  readonly init: RequestInit;
}

function fakeFetch(respond: () => Response = () => new Response('{}')): {
  fetch: typeof fetch;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const impl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init: init ?? {} });
    return Promise.resolve(respond());
  };
  return { fetch: impl, calls };
}

function headersOf(call: Captured | undefined): Record<string, string> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return (call?.init.headers ?? {}) as Record<string, string>;
}

const otelDescriptor = {
  kind: 'otel' as const,
  endpoint: 'http://collector:4318',
  headersEnv: 'OTEL_HEADERS',
};
const langfuseDescriptor = {
  kind: 'langfuse' as const,
  baseUrlEnv: 'LF_BASE_URL',
  publicKeyEnv: 'LF_PUBLIC_KEY',
  secretKeyEnv: 'LF_SECRET_KEY',
};

function caughtError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

describe('sinkRefName', () => {
  test('names a string ref by itself', () => {
    expect(sinkRefName('report')).toBe('report');
  });

  test("names a descriptor by its 'kind'", () => {
    expect(sinkRefName(otelDescriptor)).toBe('otel');
  });

  test('names an adapter-object ref by its id', () => {
    expect(sinkRefName({ specVersion: 'v1', id: 'x/y' })).toBe('x/y');
  });
});

describe('resolveSinks with descriptor sinks', () => {
  test('otel descriptor posts to <endpoint>/v1/logs with headers parsed from the named var', async () => {
    const { fetch, calls } = fakeFetch();
    const env = { OTEL_HEADERS: 'x-api-key=secret,x-team=core' };
    const [resolved] = resolveSinks({ sinks: [otelDescriptor] }, ['otel'], { env, fetch });
    expect(resolved?.sink.id).toBe('otel/logs');
    await resolved?.sink.doWrite([verdict()], {});
    expect(calls[0]?.url).toBe('http://collector:4318/v1/logs');
    const headers = headersOf(calls[0]);
    expect(headers['x-api-key']).toBe('secret');
    expect(headers['x-team']).toBe('core');
  });

  test('langfuse descriptor posts Basic auth built from the three named vars to <baseUrl>/api/public/scores', async () => {
    const { fetch, calls } = fakeFetch();
    const env = {
      LF_BASE_URL: 'https://cloud.langfuse.example',
      LF_PUBLIC_KEY: 'pub-1',
      LF_SECRET_KEY: 'sec-1',
    };
    const [resolved] = resolveSinks({ sinks: [langfuseDescriptor] }, ['langfuse'], { env, fetch });
    expect(resolved?.sink.id).toBe('langfuse/scores');
    await resolved?.sink.doWrite([verdict()], {});
    expect(calls[0]?.url).toBe('https://cloud.langfuse.example/api/public/scores');
    expect(headersOf(calls[0])['authorization']).toBe(
      `Basic ${Buffer.from('pub-1:sec-1').toString('base64')}`,
    );
  });

  test('a header value containing "=" survives parsing', async () => {
    const { fetch, calls } = fakeFetch();
    const env = { OTEL_HEADERS: 'x-token=a=b' };
    const [resolved] = resolveSinks({ sinks: [otelDescriptor] }, ['otel'], { env, fetch });
    await resolved?.sink.doWrite([verdict()], {});
    expect(headersOf(calls[0])['x-token']).toBe('a=b');
  });

  test('a malformed headers var (stray %) -> CONFIG_INVALID without the value or the pair', () => {
    const env = { OTEL_HEADERS: 'x-key=%' };
    const error = caughtError(() =>
      resolveSinks({ sinks: [otelDescriptor] }, ['otel'], { env, fetch: fakeFetch().fetch }),
    );
    expect(VetError.isInstance(error)).toBe(true);
    expect(error).toMatchObject({ code: 'CONFIG_INVALID' });
    expect(String(error)).toContain('OTEL_HEADERS');
    expect(String(error)).not.toContain('%');
    expect(String(error)).not.toContain('x-key');
  });

  test('missing secretKeyEnv var -> CONFIG_INVALID naming the var, message contains no env value', () => {
    const env = { LF_BASE_URL: 'https://cloud.langfuse.example', LF_PUBLIC_KEY: 'pub-1' };
    const error = caughtError(() =>
      resolveSinks({ sinks: [langfuseDescriptor] }, ['langfuse'], {
        env,
        fetch: fakeFetch().fetch,
      }),
    );
    expect(VetError.isInstance(error)).toBe(true);
    expect(error).toMatchObject({ code: 'CONFIG_INVALID' });
    expect(String(error)).toContain('LF_SECRET_KEY');
    expect(String(error)).not.toContain('pub-1');
  });

  test('empty var counts as missing', () => {
    const env = {
      LF_BASE_URL: 'https://cloud.langfuse.example',
      LF_PUBLIC_KEY: 'pub-1',
      LF_SECRET_KEY: '',
    };
    const error = caughtError(() =>
      resolveSinks({ sinks: [langfuseDescriptor] }, ['langfuse'], {
        env,
        fetch: fakeFetch().fetch,
      }),
    );
    expect(VetError.isInstance(error)).toBe(true);
    expect(error).toMatchObject({ code: 'CONFIG_INVALID' });
    expect(String(error)).toContain('LF_SECRET_KEY');
  });

  test('invalid baseUrl var -> CONFIG_INVALID naming the var, not the value', () => {
    const env = {
      LF_BASE_URL: 'not a url',
      LF_PUBLIC_KEY: 'pub-1',
      LF_SECRET_KEY: 'sec-1',
    };
    const error = caughtError(() =>
      resolveSinks({ sinks: [langfuseDescriptor] }, ['langfuse'], {
        env,
        fetch: fakeFetch().fetch,
      }),
    );
    expect(VetError.isInstance(error)).toBe(true);
    expect(error).toMatchObject({ code: 'CONFIG_INVALID' });
    expect(String(error)).toContain('LF_BASE_URL');
    expect(String(error)).not.toContain('not a url');
  });

  test('invalid otel endpoint -> CONFIG_INVALID naming the sink, never the input', () => {
    const badDescriptor = { kind: 'otel' as const, endpoint: 'not a url' };
    const error = caughtError(() =>
      resolveSinks({ sinks: [badDescriptor] }, ['otel'], { fetch: fakeFetch().fetch }),
    );
    expect(VetError.isInstance(error)).toBe(true);
    expect(error).toMatchObject({ code: 'CONFIG_INVALID' });
    expect(String(error)).toContain("sink 'otel'");
    expect(String(error)).not.toContain('not a url');
  });

  test("unused descriptor's vars are not read", () => {
    const badOtel = { kind: 'otel' as const, endpoint: 'not a url', headersEnv: 'MISSING_VAR' };
    const env = {
      LF_BASE_URL: 'https://cloud.langfuse.example',
      LF_PUBLIC_KEY: 'pub-1',
      LF_SECRET_KEY: 'sec-1',
    };
    const [resolved] = resolveSinks({ sinks: [badOtel, langfuseDescriptor] }, ['langfuse'], {
      env,
      fetch: fakeFetch().fetch,
    });
    expect(resolved?.sink.id).toBe('langfuse/scores');
  });

  test('descriptor and adapter object coexist; exact kind match wins', () => {
    const env = { OTEL_HEADERS: 'x=y' };
    const adapterLookalike = { specVersion: 'v1' as const, id: 'otel/custom' };
    const [resolved] = resolveSinks({ sinks: [otelDescriptor, adapterLookalike] }, ['otel'], {
      env,
      fetch: fakeFetch().fetch,
    });
    expect(resolved?.sink.id).toBe('otel/logs');
  });

  test("descriptor is named by kind; --sink otel/logs -> CONFIG_UNKNOWN_SINK listing 'otel'", () => {
    const error = caughtError(() =>
      resolveSinks({ sinks: [otelDescriptor] }, ['otel/logs'], { fetch: fakeFetch().fetch }),
    );
    expect(VetError.isInstance(error)).toBe(true);
    expect(error).toMatchObject({ code: 'CONFIG_UNKNOWN_SINK' });
    expect(String(error)).toContain('otel');
  });
});

function makeStream(): { stream: Writable; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, callback: () => void) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return { stream, text: () => chunks.join('') };
}

// In-process handleError path (matches commands/run-sinks.test.ts's exit-2 assertions), rather
// than spawning the built CLI: a missing descriptor env var must exit 2 and never print the
// stubbed value (contract yxn.13 revision 1).
describe('a missing descriptor env var, via handleError', () => {
  test('exits 2, stderr names the variable and never the stubbed value', () => {
    const error = caughtError(() =>
      resolveSinks({ sinks: [langfuseDescriptor] }, ['langfuse'], {
        env: { LF_BASE_URL: 'https://cloud.langfuse.example', LF_PUBLIC_KEY: 'pub-1' },
        fetch: fakeFetch().fetch,
      }),
    );
    const stdout = makeStream();
    const stderr = makeStream();
    let exitCode: number | undefined;
    const ctx: HandleErrorContext = {
      json: false,
      verbose: false,
      strict: false,
      stdout: stdout.stream,
      stderr: stderr.stream,
      exit: (code: number): never => {
        exitCode = code;
        throw new Error('exit');
      },
    };
    try {
      handleError(error, ctx);
    } catch {
      // expected: the stub exit() throws to unwind.
    }
    expect(exitCode).toBe(2);
    expect(stderr.text()).toContain('LF_SECRET_KEY');
    expect(stderr.text()).not.toContain('pub-1');
  });
});
