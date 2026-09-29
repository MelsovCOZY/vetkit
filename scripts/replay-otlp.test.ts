import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { hashToUnit as coreHashToUnit } from '@vetkit/core';
import { BAD_ANSWER, hashToUnit, plan, replay, rewrite, traceIdFor } from './replay-otlp.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function items(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Every span of an OTLP/JSON document, as records. */
function spansOf(text: string): Record<string, unknown>[] {
  const doc: unknown = JSON.parse(text);
  const out: Record<string, unknown>[] = [];
  if (!isRecord(doc)) return out;
  for (const resource of items(doc['resourceSpans'])) {
    if (!isRecord(resource)) continue;
    for (const scope of items(resource['scopeSpans'])) {
      if (!isRecord(scope)) continue;
      for (const span of items(scope['spans'])) if (isRecord(span)) out.push(span);
    }
  }
  return out;
}

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

  it('rewrites trace and span ids consistently and poisons only the assistant output', () => {
    const raw = readFileSync(FIXTURE, 'utf8');
    const id = traceIdFor('x', 1);
    const good = rewrite(raw, id, false);
    const bad = rewrite(raw, id, true);
    expect(good).not.toContain(BAD_ANSWER);
    expect(bad).toContain(BAD_ANSWER);
    expect(good).not.toContain('00000000000000000000000000000001');
    const spans = spansOf(good);
    const ids = new Set(spans.map((s) => s['spanId']));
    expect(spans.every((s) => s['traceId'] === id)).toBe(true);
    expect(spans.every((s) => s['parentSpanId'] === undefined || ids.has(s['parentSpanId']))).toBe(
      true,
    );
  });

  it('POSTs count distinct traces to /v1/traces', async () => {
    // vitest.setup.ts blocks fetch; this test talks to a loopback server it starts itself.
    vi.unstubAllGlobals();
    const seen: string[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        seen.push(`${req.url ?? ''} ${String(spansOf(body)[0]?.['traceId'])}`);
        res.end('{}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
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
