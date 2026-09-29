// DEFAULT_DIALECT_ORDER tests: otlpSource() with no `dialects` option must
// cascade through the five merged dialects (gen_ai, gen_ai_legacy, openinference, openllmetry,
// vercel) in Langfuse order. One inline OTLP/JSON fixture per dialect, each carrying only that
// dialect's own detect() markers so no other dialect in the cascade can also match, proves the
// full otlpSource() -> normalizeTrace() -> DialectV1.name wiring end to end.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { otlpSource } from './index.ts';

const TRACE_HEX = '5b8efff798038103d269b633813fc60c';
const SPAN_HEX = 'eee19b7ec3c1b174';

function otlpFile(attributes: Record<string, unknown>): string {
  return JSON.stringify({
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'svc' } }] },
        scopeSpans: [
          {
            scope: { name: 'test' },
            spans: [
              {
                traceId: TRACE_HEX,
                spanId: SPAN_HEX,
                name: 'span',
                kind: 1,
                startTimeUnixNano: '1700000000000000000',
                endTimeUnixNano: '1700000001000000000',
                attributes: Object.entries(attributes).map(([key, value]) => ({
                  key,
                  value: { stringValue: value },
                })),
              },
            ],
          },
        ],
      },
    ],
  });
}

const FIXTURES: Record<string, Record<string, unknown>> = {
  gen_ai: { 'gen_ai.operation.name': 'chat', 'gen_ai.input.messages': '[]' },
  gen_ai_legacy: {
    'gen_ai.operation.name': 'chat',
    'gen_ai.prompt.0.role': 'user',
    'gen_ai.prompt.0.content': 'hi',
  },
  openinference: { 'openinference.span.kind': 'LLM' },
  openllmetry: { 'traceloop.span.kind': 'llm' },
  vercel: { 'ai.operationId': 'ai.generateText.doGenerate' },
};

let dir: string;

afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
});

describe('otlpSource default dialects', () => {
  for (const [name, attributes] of Object.entries(FIXTURES)) {
    test(`reads a ${name} fixture through otlpSource() with no dialects option`, async () => {
      dir = await mkdtemp(join(tmpdir(), 'vetkit-otlp-'));
      const file = join(dir, `${name}.json`);
      await writeFile(file, otlpFile(attributes), 'utf8');

      const source = otlpSource({ files: [file] });
      const traces = [];
      for await (const trace of source.doRead({})) traces.push(trace);

      expect(traces).toHaveLength(1);
      expect(traces[0]?.dialect).toBe(name);
    });
  }
});
