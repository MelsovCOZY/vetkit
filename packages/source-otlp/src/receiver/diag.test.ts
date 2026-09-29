// startReceiver forwards the diags raised while normalizing a posted trace to opts.onDiag.

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { OtlpDiag } from '../normalize/dialect.ts';
import { startReceiver, type Receiver } from './index.ts';

const realFetch = globalThis.fetch;
beforeEach(() => {
  vi.stubGlobal('fetch', realFetch);
});

let current: Receiver | undefined;
afterEach(async () => {
  await current?.close();
  current = undefined;
});

const str = (stringValue: string) => ({ stringValue });

function body(role: string): string {
  return JSON.stringify({
    resourceSpans: [
      {
        resource: { attributes: [] },
        scopeSpans: [
          {
            spans: [
              {
                traceId: '0102030405060708090a0b0c0d0e0f10',
                spanId: '0102030405060708',
                name: 'chat',
                kind: 1,
                startTimeUnixNano: '1700000000000000000',
                endTimeUnixNano: '1700000001000000000',
                attributes: [
                  { key: 'ai.operationId', value: str('ai.generateText.doGenerate') },
                  {
                    key: 'ai.prompt.messages',
                    value: str(JSON.stringify([{ role, content: 'hi' }])),
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  });
}

async function post(onDiag: (d: OtlpDiag) => void, role: string): Promise<void> {
  current = await startReceiver({ port: 0, host: '127.0.0.1', onRequest: () => {}, onDiag });
  const res = await fetch(`http://127.0.0.1:${String(current.port)}/v1/traces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body(role),
  });
  expect(res.status).toBe(200);
}

test("a span with role 'narrator' yields one unknown_role diag on onDiag", async () => {
  const diags: OtlpDiag[] = [];
  await post((d) => diags.push(d), 'narrator');
  expect(diags).toHaveLength(1);
  expect(diags[0]).toMatchObject({
    code: 'unknown_role',
    traceId: '0102030405060708090a0b0c0d0e0f10',
  });
  expect(diags[0]?.detail).toContain('narrator');
});

test('a known role yields no diag', async () => {
  const diags: OtlpDiag[] = [];
  await post((d) => diags.push(d), 'user');
  expect(diags).toEqual([]);
});
