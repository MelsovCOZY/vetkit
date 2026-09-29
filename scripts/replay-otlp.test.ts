import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { hashToUnit as coreHashToUnit } from '@vetkit/core';
import { BAD_ANSWER, hashToUnit, plan, replay, rewrite, traceIdFor } from './replay-otlp.ts';

const FIXTURE = join(import.meta.dirname, '../fixtures/otlp/gen_ai-latest.json');

describe('replay-otlp', () => {
  it('hashToUnit matches the product sampler on every planned id', () => {
    for (const id of plan(50, 'replay', 0, 0.1).traceIds) {
      expect(hashToUnit(id)).toBe(coreHashToUnit(id));
    }
  });

  it('plans distinct deterministic ids and injects only into sampled ids', () => {
    const a = plan(100, 'replay', 1, 0.1);
    expect(new Set(a.traceIds).size).toBe(100);
    expect(plan(100, 'replay', 1, 0.1)).toEqual(a);
    expect(a.injected).toHaveLength(1);
    expect(hashToUnit(a.injected[0] ?? '')).toBeLessThan(0.1);
    expect(traceIdFor('replay', 0)).toMatch(/^[0-9a-f]{32}$/);
  });

  it('rewrites trace and span ids consistently and poisons only the assistant output', async () => {
    const { readFileSync } = await import('node:fs');
    const raw = readFileSync(FIXTURE, 'utf8');
    const id = traceIdFor('x', 1);
    const good = rewrite(raw, id, false);
    const bad = rewrite(raw, id, true);
    expect(good).not.toContain(BAD_ANSWER);
    expect(bad).toContain(BAD_ANSWER);
    expect(good).not.toContain('00000000000000000000000000000001');
    const spans = JSON.parse(good).resourceSpans[0].scopeSpans[0].spans as {
      traceId: string;
      spanId: string;
      parentSpanId?: string;
    }[];
    const ids = new Set(spans.map((s) => s.spanId));
    expect(spans.every((s) => s.traceId === id)).toBe(true);
    expect(spans.every((s) => s.parentSpanId === undefined || ids.has(s.parentSpanId))).toBe(true);
  });

  it('POSTs count distinct traces to /v1/traces', async () => {
    // vitest.setup.ts blocks fetch; this test talks to a loopback server it starts itself.
    vi.unstubAllGlobals();
    const seen: string[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        seen.push(
          `${req.url ?? ''} ${(JSON.parse(body) as { resourceSpans: { scopeSpans: { spans: { traceId: string }[] }[] }[] }).resourceSpans[0]?.scopeSpans[0]?.spans[0]?.traceId ?? ''}`,
        );
        res.end('{}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const result = await replay({
      fixture: FIXTURE,
      count: 12,
      port,
      seed: 't',
      inject: 0,
      sampleRate: 0.1,
      concurrency: 4,
    });
    server.close();
    expect(result.failures).toBe(0);
    expect(seen).toHaveLength(12);
    expect(new Set(seen).size).toBe(12);
    expect(seen.every((s) => s.startsWith('/v1/traces '))).toBe(true);
  });
});
