import { describe, expect, test } from 'vitest';
import { VetError } from '../errors.ts';
import type { NormalizedTrace } from '../generated/index.ts';
import { traceSchema } from '../generated/schemas.ts';
import { validateJson } from '../json.ts';
import { defineGenerator } from './generator.ts';
import type { GeneratorV1 } from './generator.ts';
import { defineSource } from './source.ts';
import type { SourceV1 } from './source.ts';

const trace: NormalizedTrace = {
  traceId: '0af7651916cd43dd8448eb211c80319c',
  spans: [{ spanId: 'b7ad6b7169203331', name: 'chat' }],
  messages: [
    { role: 'user', parts: [{ type: 'text', content: 'Where is my refund?' }] },
    { role: 'assistant', parts: [{ type: 'text', content: 'It is on its way.' }] },
  ],
  dialect: 'otel-genai',
  completeness: { contentCaptured: true, truncated: false, missingParents: false },
};

function makeSource(overrides: Partial<SourceV1> = {}): SourceV1 {
  return {
    specVersion: 'v1',
    id: 'jsonl',
    capabilities: { streaming: false, content: 'captured' },
    async *doRead() {
      await Promise.resolve();
      yield trace;
    },
    ...overrides,
  };
}

function makeGenerator(overrides: Partial<GeneratorV1> = {}): GeneratorV1 {
  return {
    specVersion: 'v1',
    id: 'openai-compatible',
    capabilities: { structured: 'json_schema', streaming: false },
    doGenerate: () => Promise.resolve({ value: { ok: true }, resolvedModelId: 'model-2026' }),
    ...overrides,
  };
}

function catchError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('defineSource', () => {
  test('returns a valid v1 source unchanged (same object)', () => {
    const source = makeSource();
    expect(defineSource(source)).toBe(source);
  });

  // The registry code is E_ADAPTER_SPEC_VERSION, thrown via assertSpecVersion.
  test("rejects specVersion 'v0' with E_ADAPTER_SPEC_VERSION naming the id", () => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const source = { ...makeSource(), specVersion: 'v0' } as unknown as SourceV1;
    const caught = catchError(() => defineSource(source));
    expect(VetError.isInstance(caught)).toBe(true);
    expect(caught).toMatchObject({
      code: 'E_ADAPTER_SPEC_VERSION',
      message: expect.stringContaining('jsonl'),
    });
  });

  test('a fake source yields a trace that traceSchema accepts', async () => {
    const source = defineSource(makeSource());
    const read: unknown[] = [];
    for await (const t of source.doRead({})) read.push(t);
    expect(read).toHaveLength(1);
    expect(validateJson(read[0], traceSchema).ok).toBe(true);
  });
});

describe('defineGenerator', () => {
  test('returns a valid v1 generator unchanged (same object)', () => {
    const generator = makeGenerator();
    expect(defineGenerator(generator)).toBe(generator);
  });

  test("rejects specVersion 'v0' with E_ADAPTER_SPEC_VERSION naming the id", () => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const generator = { ...makeGenerator(), specVersion: 'v0' } as unknown as GeneratorV1;
    const caught = catchError(() => defineGenerator(generator));
    expect(VetError.isInstance(caught)).toBe(true);
    expect(caught).toMatchObject({
      code: 'E_ADAPTER_SPEC_VERSION',
      message: expect.stringContaining('openai-compatible'),
    });
  });

  test('accepts an id containing a slash (bare ids, no defineAdapter id-shape check)', () => {
    const generator = makeGenerator({ id: 'ollama/llama3' });
    expect(defineGenerator(generator)).toBe(generator);
  });
});
