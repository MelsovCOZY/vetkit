import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { readOtlpDir, readOtlpJson, type OtlpFileResult, type ReadOtlpResult } from './index.ts';

const TRACE_HEX = '5b8efff798038103d269b633813fc60c';
const SPAN_HEX = 'eee19b7ec3c1b174';
const PARENT_HEX = 'eee19b7ec3c1b173';

function request(spans: Record<string, unknown>[], resource?: Record<string, unknown>): string {
  return JSON.stringify({
    resourceSpans: [
      {
        resource: resource ?? {
          attributes: [{ key: 'service.name', value: { stringValue: 'chat' } }],
        },
        schemaUrl: 'https://opentelemetry.io/schemas/1.37.0',
        scopeSpans: [{ scope: { name: 'genai' }, spans }],
      },
    ],
  });
}

function span(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    traceId: TRACE_HEX,
    spanId: SPAN_HEX,
    parentSpanId: PARENT_HEX,
    name: 'chat gpt-4o',
    kind: 3,
    startTimeUnixNano: '1700000000000000000',
    endTimeUnixNano: '1700000001000000000',
    attributes: [{ key: 'gen_ai.operation.name', value: { stringValue: 'chat' } }],
    ...overrides,
  };
}

function ok(result: ReadOtlpResult): Extract<ReadOtlpResult, { resourceSpans: unknown }> {
  if ('error' in result) throw new Error(`expected a parse, got ${result.detail}`);
  return result;
}

function hexToBase64(hex: string): string {
  return Buffer.from(hex, 'hex').toString('base64');
}

describe('readOtlpJson', () => {
  test('reads a valid hex-id ExportTraceServiceRequest and passes ids through', () => {
    const result = ok(readOtlpJson(request([span()])));

    expect(result.decodeErrors).toEqual([]);
    const rs = result.resourceSpans[0];
    expect(rs?.resource.attributes['service.name']).toBe('chat');
    expect(rs?.resource.schemaUrl).toBe('https://opentelemetry.io/schemas/1.37.0');
    const s = rs?.scopeSpans[0]?.spans[0];
    expect(s?.traceId).toBe(TRACE_HEX);
    expect(s?.spanId).toBe(SPAN_HEX);
    expect(s?.parentSpanId).toBe(PARENT_HEX);
    expect(s?.idEncoding).toBe('hex');
    expect(s?.name).toBe('chat gpt-4o');
    expect(s?.kind).toBe(3);
    expect(s?.startTimeUnixNano).toBe('1700000000000000000');
    expect(s?.endTimeUnixNano).toBe('1700000001000000000');
    expect(s?.attributes['gen_ai.operation.name']).toBe('chat');
    expect(s?.droppedAttributesCount).toBe(0);
    expect(s?.droppedEventsCount).toBe(0);
    expect(s?.status.code).toBe(0);
  });

  test('decodes base64 ids to hex and records idEncoding base64', () => {
    const text = request([
      span({
        traceId: hexToBase64(TRACE_HEX),
        spanId: hexToBase64(SPAN_HEX),
        parentSpanId: hexToBase64(PARENT_HEX),
      }),
    ]);

    const s = ok(readOtlpJson(text)).resourceSpans[0]?.scopeSpans[0]?.spans[0];

    expect(s?.traceId).toBe(TRACE_HEX);
    expect(s?.spanId).toBe(SPAN_HEX);
    expect(s?.parentSpanId).toBe(PARENT_HEX);
    expect(s?.idEncoding).toBe('base64');
  });

  test('a body without resourceSpans is OTLP_PARSE', () => {
    const result = readOtlpJson(JSON.stringify({ spans: [] }));

    expect(result).toMatchObject({ error: 'OTLP_PARSE' });
    expect('error' in result && result.detail.length > 0).toBe(true);
  });

  test('text that is not JSON is OTLP_PARSE', () => {
    expect(readOtlpJson('{"resourceSpans": [')).toMatchObject({ error: 'OTLP_PARSE' });
  });

  test('a span missing startTimeUnixNano is OTLP_PARSE', () => {
    const bad = span();
    delete bad.startTimeUnixNano;
    expect(readOtlpJson(request([bad]))).toMatchObject({ error: 'OTLP_PARSE' });
  });

  test('surfaces droppedAttributesCount 3 on the span record', () => {
    const s = ok(readOtlpJson(request([span({ droppedAttributesCount: 3 })]))).resourceSpans[0]
      ?.scopeSpans[0]?.spans[0];

    expect(s?.droppedAttributesCount).toBe(3);
  });

  test('empty resourceSpans is valid and yields zero spans', () => {
    const result = ok(readOtlpJson('{"resourceSpans":[]}'));
    expect(result.resourceSpans).toEqual([]);
    expect(result.decodeErrors).toEqual([]);
  });

  test('scopeSpans without scope is accepted', () => {
    const text = JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [span()] }] }] });
    const rs = ok(readOtlpJson(text)).resourceSpans[0];
    expect(rs?.scopeSpans[0]?.spans[0]?.spanId).toBe(SPAN_HEX);
    expect(rs?.resource.attributes).toEqual({});
  });

  test('accepts nanos as numbers as well as strings, normalised to decimal strings', () => {
    const s = ok(
      readOtlpJson(
        request([span({ startTimeUnixNano: 1_700_000_000, endTimeUnixNano: 1_700_000_500 })]),
      ),
    ).resourceSpans[0]?.scopeSpans[0]?.spans[0];

    expect(s?.startTimeUnixNano).toBe('1700000000');
    expect(s?.endTimeUnixNano).toBe('1700000500');
  });

  test('an empty parentSpanId means no parent', () => {
    const s = ok(readOtlpJson(request([span({ parentSpanId: '' })]))).resourceSpans[0]
      ?.scopeSpans[0]?.spans[0];
    expect(s?.parentSpanId).toBeUndefined();
  });

  test('an id that is neither hex nor base64 of the right length is a decode error, not a throw', () => {
    const result = ok(readOtlpJson(request([span({ spanId: 'not-an-id!' })])));

    expect(result.decodeErrors).toHaveLength(1);
    expect(result.decodeErrors[0]).toMatchObject({ field: 'spanId', value: 'not-an-id!' });
    expect(result.resourceSpans[0]?.scopeSpans[0]?.spans).toEqual([]);
  });

  test('flattens nested AnyValue attributes on spans, events and links', () => {
    const text = request([
      span({
        attributes: [
          { key: 'n', value: { intValue: '42' } },
          { key: 'b', value: { boolValue: true } },
          { key: 'd', value: { doubleValue: 0.5 } },
          {
            key: 'arr',
            value: { arrayValue: { values: [{ stringValue: 'x' }, { intValue: 1 }] } },
          },
          {
            key: 'kv',
            value: { kvlistValue: { values: [{ key: 'inner', value: { stringValue: 'y' } }] } },
          },
        ],
        events: [
          {
            timeUnixNano: '1700000000500000000',
            name: 'gen_ai.content.prompt',
            attributes: [{ key: 'gen_ai.prompt', value: { stringValue: 'hi' } }],
          },
        ],
        links: [{ traceId: TRACE_HEX, spanId: hexToBase64(PARENT_HEX) }],
        droppedEventsCount: 2,
        status: { code: 2, message: 'boom' },
      }),
    ]);

    const s = ok(readOtlpJson(text)).resourceSpans[0]?.scopeSpans[0]?.spans[0];

    expect(s?.attributes).toMatchObject({
      n: 42,
      b: true,
      d: 0.5,
      arr: ['x', 1],
      kv: { inner: 'y' },
    });
    expect(s?.events[0]).toMatchObject({
      name: 'gen_ai.content.prompt',
      timeUnixNano: '1700000000500000000',
      attributes: { 'gen_ai.prompt': 'hi' },
    });
    expect(s?.links[0]).toMatchObject({ traceId: TRACE_HEX, spanId: PARENT_HEX });
    expect(s?.droppedEventsCount).toBe(2);
    expect(s?.status).toMatchObject({ code: 2, message: 'boom' });
  });
});

describe('readOtlpDir', () => {
  let dir = '';
  afterEach(async () => {
    if (dir !== '') await rm(dir, { recursive: true, force: true });
  });

  test('reads *.json and *.jsonl files in name order and yields per-file results', async () => {
    dir = await mkdtemp(join(tmpdir(), 'otlp-dir-'));
    await writeFile(
      join(dir, 'b.jsonl'),
      `${request([span()])}\n\n${request([span({ name: 'second' })])}\n`,
    );
    await writeFile(join(dir, 'a.json'), request([span({ name: 'first' })]));
    await writeFile(join(dir, 'notes.txt'), 'ignored');

    const files: OtlpFileResult[] = [];
    for await (const file of readOtlpDir(dir)) files.push(file);

    expect(files.map((f) => f.file)).toEqual([join(dir, 'a.json'), join(dir, 'b.jsonl')]);
    expect(files[0]?.results).toHaveLength(1);
    expect(files[1]?.results).toHaveLength(2);
    const names = files.flatMap((f) =>
      f.results.flatMap((r) =>
        'error' in r
          ? []
          : r.resourceSpans.flatMap((rs) =>
              rs.scopeSpans.flatMap((ss) => ss.spans.map((s) => s.name)),
            ),
      ),
    );
    expect(names).toEqual(['first', 'chat gpt-4o', 'second']);
  });
});
