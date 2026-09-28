import type { GeneratorV1, NormalizedTrace } from '@vetkit/spec';
import { describe, expect, test, vi } from 'vitest';
import { createEvents, type DiagEvent } from '../events.ts';
import { MIN_FAILURE_MODES, proposeFailureModes } from './failure-modes.ts';
import { FAILURE_MODES_PROMPT, FAILURE_MODES_SCHEMA } from './prompts.ts';

type DoGenerate = GeneratorV1['doGenerate'];

function fakeGenerator(
  value: unknown,
  resolvedModelId = 'acme/model-1',
): {
  generator: GeneratorV1;
  doGenerate: ReturnType<typeof vi.fn<DoGenerate>>;
} {
  const doGenerate = vi.fn<DoGenerate>(() => Promise.resolve({ value, resolvedModelId }));
  const generator: GeneratorV1 = {
    specVersion: 'v1',
    id: 'fake',
    capabilities: { structured: 'json_schema', streaming: false },
    doGenerate,
  };
  return { generator, doGenerate };
}

function trace(traceId: string, answer = `answer for ${traceId}`): NormalizedTrace {
  return {
    traceId,
    spans: [],
    messages: [
      { role: 'user', parts: [{ type: 'text', content: `question for ${traceId}` }] },
      { role: 'assistant', parts: [{ type: 'text', content: answer }] },
    ],
    dialect: 'test',
    completeness: { contentCaptured: true, truncated: false, missingParents: false },
  };
}

function traces(n: number): NormalizedTrace[] {
  return Array.from({ length: n }, (_, i) => trace(`t${i}`));
}

function collectDiags(): { events: ReturnType<typeof createEvents>; diags: DiagEvent[] } {
  const events = createEvents();
  const diags: DiagEvent[] = [];
  events.on('diag', (d) => diags.push(d));
  return { events, diags };
}

function mode(name: string, id: string) {
  return { name, description: `${name} happens.`, exampleTraceIds: [id] };
}

describe('proposeFailureModes', () => {
  test('sends one structured call with the failure-mode schema and returns failure modes', async () => {
    const { generator, doGenerate } = fakeGenerator({
      failureModes: [
        {
          name: 'wrong-refund-amount',
          description: 'States a wrong refund.',
          exampleTraceIds: ['t1'],
        },
      ],
    });
    const signal = new AbortController().signal;

    const modes = await proposeFailureModes({ generator, traces: traces(6), signal });

    expect(doGenerate).toHaveBeenCalledTimes(1);
    const req = doGenerate.mock.calls[0]?.[0];
    expect(req?.schema?.jsonSchema).toBe(FAILURE_MODES_SCHEMA);
    expect(req?.system).toBe(FAILURE_MODES_PROMPT);
    expect(req?.signal).toBe(signal);
    expect(modes).toEqual([
      {
        name: 'wrong-refund-amount',
        description: 'States a wrong refund.',
        exampleTraceIds: ['t1'],
      },
    ]);
  });

  test('the digest holds at most 20 traces', async () => {
    const { generator, doGenerate } = fakeGenerator({ failureModes: [] });

    await proposeFailureModes({ generator, traces: traces(50) });

    const prompt = doGenerate.mock.calls[0]?.[0].prompt ?? '';
    const ids = prompt.match(/^### trace t\d+$/gm) ?? [];
    expect(ids).toHaveLength(20);
  });

  test('sampling is reproducible for the same seed', async () => {
    const a = fakeGenerator({ failureModes: [] });
    const b = fakeGenerator({ failureModes: [] });

    await proposeFailureModes({ generator: a.generator, traces: traces(50), seed: 7 });
    await proposeFailureModes({ generator: b.generator, traces: traces(50), seed: 7 });

    expect(a.doGenerate.mock.calls[0]?.[0].prompt).toBe(b.doGenerate.mock.calls[0]?.[0].prompt);
  });

  test('each trace in the digest keeps only its last 2000 characters', async () => {
    const long = `${'x'.repeat(5000)}TAIL`;
    const { generator, doGenerate } = fakeGenerator({ failureModes: [] });

    await proposeFailureModes({ generator, traces: [trace('t0', long)] });

    const prompt = doGenerate.mock.calls[0]?.[0].prompt ?? '';
    expect(prompt).toContain('TAIL');
    expect(prompt).not.toContain('x'.repeat(2001));
  });

  test('fewer than 5 traces still makes one call and warns via events', async () => {
    const { generator, doGenerate } = fakeGenerator({ failureModes: [] });
    const { events, diags } = collectDiags();

    await proposeFailureModes({ generator, traces: traces(3), events });

    expect(doGenerate).toHaveBeenCalledTimes(1);
    expect(diags.some((d) => d.level === 'warn' && d.code === 'FEW_TRACES')).toBe(true);
  });

  test('duplicate failure-mode names keep the first and record a diag', async () => {
    const { generator } = fakeGenerator({
      failureModes: [
        { name: 'dup', description: 'first', exampleTraceIds: ['t0'] },
        { name: 'dup', description: 'second', exampleTraceIds: ['t1'] },
      ],
    });
    const { events, diags } = collectDiags();

    const modes = await proposeFailureModes({ generator, traces: traces(6), events });

    expect(modes.map((m) => m.description)).toEqual(['first']);
    expect(diags.some((d) => d.code === 'DUPLICATE_FAILURE_MODE')).toBe(true);
  });

  test('unknown exampleTraceIds are dropped', async () => {
    const { generator } = fakeGenerator({
      failureModes: [{ name: 'a', description: 'd', exampleTraceIds: ['t1', 'nope'] }],
    });

    const modes = await proposeFailureModes({ generator, traces: traces(6) });

    expect(modes[0]?.exampleTraceIds).toEqual(['t1']);
  });

  test('a failure mode with no known trace ids falls back to the digest trace ids', async () => {
    const { generator } = fakeGenerator({
      failureModes: [{ name: 'a', description: 'd', exampleTraceIds: ['nope'] }],
    });
    const input = traces(6);

    const modes = await proposeFailureModes({ generator, traces: input });

    const ids = modes[0]?.exampleTraceIds ?? [];
    expect(ids.length).toBeGreaterThanOrEqual(1);
    const known = new Set(input.map((t) => t.traceId));
    expect(ids.every((id) => known.has(id))).toBe(true);
  });

  test('output that fails the schema is rejected', async () => {
    const { generator } = fakeGenerator({ failureModes: [{ name: 'a' }] });

    await expect(proposeFailureModes({ generator, traces: traces(6) })).rejects.toMatchObject({
      code: 'E_SCHEMA_INVALID',
    });
  });

  test('a prompt-mode generator returning text is parsed and validated', async () => {
    const doGenerate = vi.fn<DoGenerate>(() =>
      Promise.resolve({
        text: '{"failureModes":[{"name":"a","description":"d","exampleTraceIds":["t2"]}]}',
      }),
    );
    const generator: GeneratorV1 = {
      specVersion: 'v1',
      id: 'fake',
      capabilities: { structured: 'prompt', streaming: false },
      doGenerate,
    };

    const modes = await proposeFailureModes({ generator, traces: traces(6) });

    expect(modes).toEqual([{ name: 'a', description: 'd', exampleTraceIds: ['t2'] }]);
  });

  test('the prompt asks for at least MIN_FAILURE_MODES (>= 5) distinct failure modes', () => {
    expect(MIN_FAILURE_MODES).toBeGreaterThanOrEqual(5);
    expect(FAILURE_MODES_PROMPT).toContain(`at least ${MIN_FAILURE_MODES}`);
  });

  test('too few modes on a 50-trace corpus: one top-up call over unsampled traces', async () => {
    const replies = [
      { failureModes: [mode('missing-citation', 't1')] },
      {
        failureModes: [
          mode('missing-citation', 't2'),
          mode('rude-tone', 't3'),
          mode('wrong-refund', 't4'),
          mode('leaks-pii', 't5'),
          mode('off-topic', 't6'),
        ],
      },
    ];
    let call = 0;
    const doGenerate = vi.fn<DoGenerate>(() => {
      const value = replies[Math.min(call, replies.length - 1)];
      call += 1;
      return Promise.resolve({ value, resolvedModelId: 'acme/model-1' });
    });
    const generator: GeneratorV1 = {
      specVersion: 'v1',
      id: 'fake',
      capabilities: { structured: 'json_schema', streaming: false },
      doGenerate,
    };

    const modes = await proposeFailureModes({ generator, traces: traces(50) });

    expect(doGenerate).toHaveBeenCalledTimes(2);
    const idsOf = (i: number) =>
      (doGenerate.mock.calls[i]?.[0].prompt ?? '').match(/^### trace t\d+$/gm) ?? [];
    expect(idsOf(1).length).toBeGreaterThan(0);
    const first = new Set(idsOf(0));
    expect(idsOf(1).some((id) => first.has(id))).toBe(false);
    expect(doGenerate.mock.calls[1]?.[0].prompt).toContain('missing-citation');
    expect(doGenerate.mock.calls[1]?.[0].schema?.jsonSchema).toBe(FAILURE_MODES_SCHEMA);
    expect(modes.map((m) => m.name)).toEqual([
      'missing-citation',
      'rude-tone',
      'wrong-refund',
      'leaks-pii',
      'off-topic',
    ]);
  });

  test('no top-up call when the first call already yields enough modes', async () => {
    const { generator, doGenerate } = fakeGenerator({
      failureModes: Array.from({ length: MIN_FAILURE_MODES }, (_, i) => ({
        name: `mode-${i}`,
        description: 'd',
        exampleTraceIds: [`t${i}`],
      })),
    });

    const modes = await proposeFailureModes({ generator, traces: traces(50) });

    expect(doGenerate).toHaveBeenCalledTimes(1);
    expect(modes).toHaveLength(MIN_FAILURE_MODES);
  });
});
