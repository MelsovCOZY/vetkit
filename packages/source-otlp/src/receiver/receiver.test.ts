// Unit tests for the OTLP/HTTP receiver (bead mol-pij.8, root acceptance J5). Every test binds
// port 0 (ephemeral) and talks to the server over real loopback fetch; port 4318 is never bound
// here. Cross-request traceId dedupe is not this module's job (contract pij.8 revision 3: it
// lives in the CLI's otlpSourceFromArg, tested in packages/cli/src/commands/init-otlp.test.ts).
import { gzipSync } from 'node:zlib';
import type { NormalizedTrace } from '@vetkit/spec';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { startReceiver, type Receiver } from './index.ts';

// vitest.setup.ts replaces global fetch with a network-blocking guard by default (unit tests
// never make live calls); this suite's whole point is real loopback HTTP against an in-process
// server on an ephemeral port, so every test here restores the platform fetch captured at
// import time, before the guard ever ran.
const realFetch = globalThis.fetch;
beforeEach(() => {
  vi.stubGlobal('fetch', realFetch);
});

function validTraceBody(traceId = '0102030405060708090a0b0c0d0e0f10'): string {
  return JSON.stringify({
    resourceSpans: [
      {
        resource: { attributes: [] },
        scopeSpans: [
          {
            spans: [
              {
                traceId,
                spanId: '0102030405060708',
                name: 'root',
                kind: 1,
                startTimeUnixNano: '1700000000000000000',
                endTimeUnixNano: '1700000001000000000',
                attributes: [],
              },
            ],
          },
        ],
      },
    ],
  });
}

let current: Receiver | undefined;

async function open(onRequest: (trace: NormalizedTrace) => void): Promise<Receiver> {
  current = await startReceiver({ port: 0, host: '127.0.0.1', onRequest });
  return current;
}

function url(receiver: Receiver, path = '/v1/traces'): string {
  return `http://127.0.0.1:${String(receiver.port)}${path}`;
}

afterEach(async () => {
  await current?.close();
  current = undefined;
});

describe('startReceiver', () => {
  test('POST /v1/traces with valid JSON returns 200 partialSuccess', async () => {
    const seen: NormalizedTrace[] = [];
    const receiver = await open((trace) => seen.push(trace));
    const res = await fetch(url(receiver), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: validTraceBody(),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ partialSuccess: {} });
    expect(seen).toHaveLength(1);
  });

  test('invalid JSON body returns 400 OTLP_PARSE', async () => {
    const receiver = await open(() => {
      throw new Error('onRequest must not be called for an invalid body');
    });
    const res = await fetch(url(receiver), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'OTLP_PARSE' });
  });

  test('application/x-protobuf returns 415 json only', async () => {
    const receiver = await open(() => {
      throw new Error('onRequest must not be called for a non-JSON content type');
    });
    const res = await fetch(url(receiver), {
      method: 'POST',
      headers: { 'content-type': 'application/x-protobuf' },
      body: Buffer.from([0, 1, 2]),
    });
    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({ error: 'json only' });
  });

  test('body over 16 MiB returns 413', async () => {
    const receiver = await open(() => {
      throw new Error('onRequest must not be called for an oversized body');
    });
    const oversized = Buffer.alloc(16 * 1024 * 1024 + 1, 0x20);
    const res = await fetch(url(receiver), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: oversized,
    });
    expect(res.status).toBe(413);
  }, 30_000);

  test('gzip content-encoding is transparently decoded', async () => {
    const seen: NormalizedTrace[] = [];
    const receiver = await open((trace) => seen.push(trace));
    const res = await fetch(url(receiver), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      body: gzipSync(Buffer.from(validTraceBody(), 'utf8')),
    });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
  });

  test('a request with zero spans returns 200 with zero traces observed', async () => {
    const seen: NormalizedTrace[] = [];
    const receiver = await open((trace) => seen.push(trace));
    const res = await fetch(url(receiver), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resourceSpans: [] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ partialSuccess: {} });
    expect(seen).toHaveLength(0);
  });
});
