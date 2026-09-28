import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { traceSchema, validateJson, type NormalizedTrace } from '@vetkit/spec';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createJsonlSource, type JsonlDiag } from './index.ts';

// ESM namespaces are sealed, so the fs spy goes through vi.mock: every createReadStream the
// source makes is recorded while still delegating to the real implementation.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) };
});

const SAMPLE_DIR = fileURLToPath(new URL('../../../fixtures/traces-sample/', import.meta.url));

async function collect(dir: string): Promise<{ traces: NormalizedTrace[]; diags: JsonlDiag[] }> {
  const diags: JsonlDiag[] = [];
  const source = createJsonlSource({ dir, onDiag: (d) => diags.push(d) });
  const traces: NormalizedTrace[] = [];
  for await (const trace of source.doRead({})) traces.push(trace);
  return { traces, diags };
}

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'vetkit-jsonl-'));
  vi.mocked(fs.createReadStream).mockClear();
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const COMPLETE = { contentCaptured: true, truncated: false, missingParents: false };

describe('createJsonlSource', () => {
  test('declares SourceV1 metadata with streaming and captured content', () => {
    const source = createJsonlSource({ dir: SAMPLE_DIR });
    expect(source.specVersion).toBe('v1');
    expect(source.capabilities).toEqual({ streaming: true, content: 'captured' });
    expect(typeof source.id).toBe('string');
  });

  test('yields one schema-valid NormalizedTrace per fixture line', async () => {
    const { traces, diags } = await collect(SAMPLE_DIR);
    expect(traces).toHaveLength(5);
    expect(diags).toEqual([]);
    for (const trace of traces) {
      expect(validateJson(trace, traceSchema).ok).toBe(true);
      expect(trace.completeness).toEqual(COMPLETE);
    }
  });

  test('maps the own export shape with dialect jsonl-own and spans defaulting to []', async () => {
    const { traces } = await collect(SAMPLE_DIR);
    const own1 = traces.find((t) => t.traceId === 'own-1');
    const own2 = traces.find((t) => t.traceId === 'own-2');
    expect(own1?.dialect).toBe('jsonl-own');
    expect(own1?.spans).toEqual([]);
    expect(own1?.messages[0]).toEqual({
      role: 'user',
      parts: [{ type: 'text', content: 'What is the refund window?' }],
    });
    expect(own2?.spans).toEqual([
      { spanId: 's1', name: 'chat', kind: 'llm', messageRange: [0, 1] },
    ]);
  });

  test('maps the OpenAI shape with dialect jsonl-openai and text parts', async () => {
    const { traces } = await collect(SAMPLE_DIR);
    const oa1 = traces.find((t) => t.traceId === 'oa-1');
    expect(oa1?.dialect).toBe('jsonl-openai');
    expect(oa1?.spans).toEqual([]);
    expect(oa1?.messages).toEqual([
      { role: 'system', parts: [{ type: 'text', content: 'You are a support agent.' }] },
      { role: 'user', parts: [{ type: 'text', content: 'Where is my parcel?' }] },
      { role: 'assistant', parts: [{ type: 'text', content: 'It left the depot this morning.' }] },
    ]);
  });

  test('uses the sha256 of the raw line as traceId when an OpenAI line has no id', async () => {
    const line = fs
      .readFileSync(join(SAMPLE_DIR, 'openai.jsonl'), 'utf8')
      .split('\n')
      .find((l) => l.startsWith('{"messages"'));
    expect(line).toBeDefined();
    const expected = createHash('sha256')
      .update(line ?? '')
      .digest('hex');
    const { traces } = await collect(SAMPLE_DIR);
    expect(traces.some((t) => t.traceId === expected && t.dialect === 'jsonl-openai')).toBe(true);
  });

  test('maps OpenAI tool_calls, tool responses and array text content', async () => {
    const { traces } = await collect(SAMPLE_DIR);
    const oa3 = traces.find((t) => t.traceId === 'oa-3');
    expect(oa3?.messages).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'Weather in Paris?' }] },
      {
        role: 'assistant',
        parts: [
          { type: 'tool_call', id: 'call_1', name: 'get_weather', arguments: '{"city":"Paris"}' },
        ],
      },
      {
        role: 'tool',
        parts: [{ type: 'tool_call_response', id: 'call_1', response: '18C, cloudy' }],
      },
      {
        role: 'assistant',
        parts: [{ type: 'text', content: 'It is 18C and cloudy in Paris.' }],
      },
    ]);
  });

  test('reports invalid lines as TRACE_INVALID with file:line and skips them', async () => {
    const good = '{"traceId":"t1","messages":[]}';
    await writeFile(
      join(tmp, 'mixed.jsonl'),
      [good, 'not json', '{"foo":1}', '{"traceId":"t2","messages":[]}'].join('\n'),
    );
    const { traces, diags } = await collect(tmp);
    expect(traces.map((t) => t.traceId)).toEqual(['t1', 't2']);
    const invalid = diags.filter((d) => d.code === 'TRACE_INVALID');
    expect(invalid).toHaveLength(2);
    expect(invalid[0]?.message).toContain('mixed.jsonl:2');
    expect(invalid[1]?.message).toContain('mixed.jsonl:3');
    expect(invalid[0]?.data).toMatchObject({ line: 2 });
  });

  test('never throws on invalid content: doRead completes', async () => {
    await writeFile(join(tmp, 'bad.jsonl'), '{\n[1,2]\n"x"\n');
    await expect(collect(tmp)).resolves.toMatchObject({ traces: [] });
  });

  test('strips a BOM at file start', async () => {
    await writeFile(join(tmp, 'bom.jsonl'), '﻿{"traceId":"b1","messages":[]}\n');
    const { traces, diags } = await collect(tmp);
    expect(traces.map((t) => t.traceId)).toEqual(['b1']);
    expect(diags).toEqual([]);
  });

  test('skips blank lines without a diag', async () => {
    await writeFile(join(tmp, 'blank.jsonl'), '\n{"traceId":"x","messages":[]}\n\n');
    const { traces, diags } = await collect(tmp);
    expect(traces).toHaveLength(1);
    expect(diags).toEqual([]);
  });

  test('reports a line over 1 MB as TRACE_INVALID line too large', async () => {
    const huge = `{"traceId":"big","messages":[],"pad":"${'a'.repeat(1024 * 1024)}"}`;
    await writeFile(join(tmp, 'big.jsonl'), `${huge}\n{"traceId":"ok","messages":[]}\n`);
    const { traces, diags } = await collect(tmp);
    expect(traces.map((t) => t.traceId)).toEqual(['ok']);
    expect(diags).toHaveLength(1);
    expect(diags[0]?.code).toBe('TRACE_INVALID');
    expect(diags[0]?.message).toContain('line too large');
    expect(diags[0]?.message).toContain('big.jsonl:1');
  });

  test('a folder with no *.jsonl files yields zero traces and one SOURCE_UNREADABLE diag', async () => {
    await writeFile(join(tmp, 'notes.txt'), '{"traceId":"t","messages":[]}\n');
    const { traces, diags } = await collect(tmp);
    expect(traces).toEqual([]);
    expect(diags).toHaveLength(1);
    expect(diags[0]?.code).toBe('SOURCE_UNREADABLE');
  });

  test('a missing folder is a SOURCE_UNREADABLE diag, not a throw', async () => {
    const { traces, diags } = await collect(join(tmp, 'does-not-exist'));
    expect(traces).toEqual([]);
    expect(diags.map((d) => d.code)).toEqual(['SOURCE_UNREADABLE']);
  });

  test('does not scan nested directories', async () => {
    await mkdir(join(tmp, 'nested'));
    await writeFile(join(tmp, 'nested', 'inner.jsonl'), '{"traceId":"inner","messages":[]}\n');
    await writeFile(join(tmp, 'top.jsonl'), '{"traceId":"top","messages":[]}\n');
    const { traces } = await collect(tmp);
    expect(traces.map((t) => t.traceId)).toEqual(['top']);
  });

  test('reads lazily: the second file is not opened until the first is consumed', async () => {
    await writeFile(
      join(tmp, 'a.jsonl'),
      '{"traceId":"a1","messages":[]}\n{"traceId":"a2","messages":[]}\n',
    );
    await writeFile(join(tmp, 'b.jsonl'), '{"traceId":"b1","messages":[]}\n');
    const opened = vi.mocked(fs.createReadStream);
    const iterator = createJsonlSource({ dir: tmp }).doRead({})[Symbol.asyncIterator]();

    expect(opened).not.toHaveBeenCalled();
    expect((await iterator.next()).value?.traceId).toBe('a1');
    expect(opened).toHaveBeenCalledTimes(1);
    expect((await iterator.next()).value?.traceId).toBe('a2');
    expect(opened).toHaveBeenCalledTimes(1);
    expect((await iterator.next()).value?.traceId).toBe('b1');
    expect(opened).toHaveBeenCalledTimes(2);
    expect((await iterator.next()).done).toBe(true);
  });

  test('stops reading when the signal is aborted', async () => {
    await writeFile(
      join(tmp, 'a.jsonl'),
      '{"traceId":"a1","messages":[]}\n{"traceId":"a2","messages":[]}\n',
    );
    const controller = new AbortController();
    const seen: string[] = [];
    const run = async (): Promise<void> => {
      for await (const trace of createJsonlSource({ dir: tmp }).doRead({
        signal: controller.signal,
      })) {
        seen.push(trace.traceId);
        controller.abort();
      }
    };
    await expect(run()).rejects.toThrow();
    expect(seen).toEqual(['a1']);
  });
});
