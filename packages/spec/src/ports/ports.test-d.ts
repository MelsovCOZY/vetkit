import { expectTypeOf, test } from 'vitest';
import { defineGenerator, defineSource } from '../index.ts';
import type {
  GeneratorV1,
  JsonSchema,
  Message,
  MessagePart,
  NormalizedTrace,
  SourceV1,
  Span,
} from '../index.ts';

// Type-level only: vitest typecheck never executes these, so they are declared, not defined.
declare const doGenerate: () => Promise<{ text: string }>;
declare const doRead: () => AsyncIterable<NormalizedTrace>;

test('defineSource and defineGenerator are importable from the @vetkit/spec index', () => {
  expectTypeOf(defineSource).toEqualTypeOf<(x: SourceV1) => SourceV1>();
  expectTypeOf(defineGenerator).toEqualTypeOf<(x: GeneratorV1) => GeneratorV1>();
});

test('SourceV1 matches the J2 contract body', () => {
  expectTypeOf<SourceV1['specVersion']>().toEqualTypeOf<'v1'>();
  expectTypeOf<SourceV1['id']>().toEqualTypeOf<string>();
  expectTypeOf<SourceV1['capabilities']>().toEqualTypeOf<{
    streaming: boolean;
    content: 'captured' | 'maybe' | 'never';
  }>();
  expectTypeOf<SourceV1['doRead']>().parameter(0).toEqualTypeOf<{ signal?: AbortSignal }>();
  expectTypeOf<SourceV1['doRead']>().returns.toEqualTypeOf<AsyncIterable<NormalizedTrace>>();
});

test('GeneratorV1 matches the J2 contract body', () => {
  expectTypeOf<GeneratorV1['specVersion']>().toEqualTypeOf<'v1'>();
  expectTypeOf<GeneratorV1['capabilities']>().toEqualTypeOf<{
    structured: 'json_schema' | 'json_object' | 'tool' | 'prompt';
    streaming: boolean;
  }>();
  expectTypeOf<GeneratorV1['doGenerate']>().parameter(0).toEqualTypeOf<{
    system?: string;
    prompt: string;
    schema?: { name: string; jsonSchema: JsonSchema };
    signal?: AbortSignal;
  }>();
  expectTypeOf<GeneratorV1['doGenerate']>().returns.toEqualTypeOf<
    Promise<{
      value?: unknown;
      text?: string;
      usage?: { inputTokens?: number; outputTokens?: number };
      resolvedModelId?: string;
    }>
  >();
});

test('NormalizedTrace carries traceId, spans, messages, dialect and completeness', () => {
  expectTypeOf<NormalizedTrace['traceId']>().toEqualTypeOf<string>();
  expectTypeOf<NormalizedTrace['spans']>().toEqualTypeOf<Span[]>();
  expectTypeOf<NormalizedTrace['messages']>().toEqualTypeOf<Message[]>();
  expectTypeOf<NormalizedTrace['dialect']>().toEqualTypeOf<string>();
  expectTypeOf<NormalizedTrace['dialectVersion']>().toEqualTypeOf<string | undefined>();
  expectTypeOf<NormalizedTrace['schemaUrl']>().toEqualTypeOf<string | undefined>();
  expectTypeOf<NormalizedTrace['completeness']>().toEqualTypeOf<{
    contentCaptured: boolean;
    truncated: boolean;
    missingParents: boolean;
  }>();
  expectTypeOf<NonNullable<NormalizedTrace['tokens']>>().toEqualTypeOf<{
    input?: number;
    output?: number;
    total?: number;
  }>();
});

test('Message has the four roles and a parts array of MessagePart', () => {
  expectTypeOf<Message['role']>().toEqualTypeOf<'user' | 'assistant' | 'system' | 'tool'>();
  expectTypeOf<Message['parts']>().toEqualTypeOf<MessagePart[]>();
  expectTypeOf<MessagePart['type']>().toEqualTypeOf<
    'text' | 'tool_call' | 'tool_call_response' | 'parse_error'
  >();
  expectTypeOf<Extract<MessagePart, { type: 'text' }>>().toHaveProperty('content');
  expectTypeOf<Extract<MessagePart, { type: 'tool_call_response' }>>().toHaveProperty('response');
  expectTypeOf<Extract<MessagePart, { type: 'parse_error' }>>().toHaveProperty('detail');
});

test('Span has spanId and name, with optional kind', () => {
  expectTypeOf<Span['spanId']>().toEqualTypeOf<string>();
  expectTypeOf<Span['name']>().toEqualTypeOf<string>();
  expectTypeOf<Span['kind']>().toEqualTypeOf<'llm' | 'tool' | 'other' | undefined>();
});

test("defineSource rejects a wrong content literal and specVersion 'v2' at the type level", () => {
  defineSource({
    specVersion: 'v1',
    id: 'jsonl',
    // @ts-expect-error content must be 'captured' | 'maybe' | 'never'
    capabilities: { streaming: false, content: 'always' },
    doRead,
  });
  defineSource({
    // @ts-expect-error specVersion must be 'v1'
    specVersion: 'v2',
    id: 'jsonl',
    capabilities: { streaming: false, content: 'captured' },
    doRead,
  });
});

test('defineSource rejects a doRead that is not an AsyncIterable', () => {
  defineSource({
    specVersion: 'v1',
    id: 'jsonl',
    capabilities: { streaming: false, content: 'captured' },
    // @ts-expect-error doRead must return AsyncIterable<NormalizedTrace>, not an array
    doRead: (): NormalizedTrace[] => [],
  });
});

test('defineGenerator rejects a wrong structured literal at the type level', () => {
  defineGenerator({
    specVersion: 'v1',
    id: 'openai-compatible',
    // @ts-expect-error structured must be json_schema | json_object | tool | prompt
    capabilities: { structured: 'grammar', streaming: false },
    doGenerate,
  });
});

test('doGenerate schema must include name', () => {
  const generator: GeneratorV1 = {
    specVersion: 'v1',
    id: 'openai-compatible',
    capabilities: { structured: 'json_schema', streaming: false },
    doGenerate,
  };
  void generator.doGenerate({
    prompt: 'p',
    // @ts-expect-error schema requires name alongside jsonSchema
    schema: { jsonSchema: { type: 'object' } },
  });
});
