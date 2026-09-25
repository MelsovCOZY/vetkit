import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Trace } from './corpus.ts';
import {
  CRITERIA_SCHEMA,
  FAILURE_MODES_SCHEMA,
  FIXED_CRITERIA,
  ShortfallError,
  handleShortfall,
  lintCriterion,
  proposeCriteria,
  sampleTraces,
  type Criterion,
  type GeneratorCall,
} from './propose.ts';

const TRACES_PATH = fileURLToPath(new URL('./data/traces.jsonl', import.meta.url));

async function loadRealTraces(): Promise<Trace[]> {
  const raw = await readFile(TRACES_PATH, 'utf8');
  return raw
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Trace);
}

function goodCriterion(name: string, traceIds: string[], suffix = ''): {
  name: string;
  instructions: string;
  escape: string;
  provenanceTraceIds: string[];
} {
  return {
    name,
    instructions: `Does the answer exhibit ${name}${suffix}?`,
    escape: 'unclear',
    provenanceTraceIds: traceIds,
  };
}

function stubFetchSequence(replies: unknown[]): ReturnType<typeof vi.fn> {
  const fn = vi.fn();
  for (const reply of replies) {
    fn.mockImplementationOnce(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => reply,
    }));
  }
  return fn;
}

function chatCompletionReply(model: string, payload: unknown): unknown {
  return { model, choices: [{ message: { content: JSON.stringify(payload) } }] };
}

describe('FIXED_CRITERIA (unit)', () => {
  test('has exactly c1, c2, c3 with the specified escape labels', () => {
    expect(FIXED_CRITERIA.map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
    expect(FIXED_CRITERIA.find((c) => c.id === 'c1')).toMatchObject({
      name: 'answer_correct',
      escape: 'reference not comparable',
    });
    expect(FIXED_CRITERIA.find((c) => c.id === 'c2')).toMatchObject({
      name: 'abstains_when_unanswerable',
      escape: 'unclear',
    });
    expect(FIXED_CRITERIA.find((c) => c.id === 'c3')).toMatchObject({
      name: 'faithful_to_context',
      escape: 'no factual claims',
    });
  });

  test('every fixed criterion passes lintCriterion', () => {
    for (const c of FIXED_CRITERIA) {
      expect(lintCriterion(c)).toEqual({ ok: true });
    }
  });
});

describe('lintCriterion (unit)', () => {
  test('passes a well-formed criterion', () => {
    expect(lintCriterion({ instructions: 'Does the answer cite a source marker?', escape: 'unclear' })).toEqual({
      ok: true,
    });
  });

  test('fails a criterion with no escape option', () => {
    expect(lintCriterion({ instructions: 'Does the answer cite a source marker?', escape: '' })).toEqual({
      ok: false,
      rule: 'missing escape option',
    });
  });

  test('fails a criterion whose instructions contain a double negative', () => {
    const result = lintCriterion({
      instructions: 'Is it not true that the answer does not cite a source?',
      escape: 'unclear',
    });
    expect(result).toEqual({ ok: false, rule: 'double negative' });
  });

  test('fails a criterion that asks Jev to count or compute', () => {
    expect(
      lintCriterion({ instructions: 'Count how many numbers appear in the answer.', escape: 'unclear' }),
    ).toEqual({ ok: false, rule: 'asks Jev to count, compute or reason about dates' });
  });

  test('fails a criterion whose instructions exceed 200 characters', () => {
    expect(lintCriterion({ instructions: 'x'.repeat(201), escape: 'unclear' })).toEqual({
      ok: false,
      rule: 'instructions over 200 characters',
    });
  });
});

describe('sampleTraces (unit, real corpus)', () => {
  test('returns 15 distinct traces spread across the 456-row corpus, under the 20k character budget', async () => {
    const traces = await loadRealTraces();
    const sample = sampleTraces(traces);

    expect(sample).toHaveLength(15);
    expect(new Set(sample.map((t) => t.traceId)).size).toBe(15);

    const promptChars = JSON.stringify(
      sample.map((t) => ({ traceId: t.traceId, lang: t.lang, question: t.question, answer: t.answer })),
    ).length;
    expect(promptChars).toBeLessThanOrEqual(20_000);
  });
});

describe('proposeCriteria (unit, fetch stubbed)', () => {
  const model = 'anthropic/claude-sonnet-5';
  let realTraces: Trace[];
  let realTraceIds: string[];

  beforeEach(async () => {
    realTraces = await loadRealTraces();
    realTraceIds = sampleTraces(realTraces).map((t) => t.traceId);
    vi.stubEnv('AI_GATEWAY_API_KEY', 'test-key');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function makeCall(fetchMock: ReturnType<typeof vi.fn>): GeneratorCall {
    vi.stubGlobal('fetch', fetchMock);
    return async ({ schemaName, jsonSchema, messages }) => {
      const { gatewayFetch } = await import('./lib/index.ts');
      const res = await gatewayFetch(
        '/v1/chat/completions',
        {
          model,
          messages,
          response_format: { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema: jsonSchema } },
        },
        { timeoutMs: 30_000 },
      );
      const content = (res as { choices: { message: { content: string } }[] }).choices[0]!.message.content;
      return JSON.parse(content);
    };
  }

  test('makes exactly two generator calls with the failure-mode and criteria schemas, using real corpus provenance', async () => {
    const failureModes = Array.from({ length: 10 }, (_, i) => ({
      name: `mode_${i}`,
      description: `failure mode ${i}`,
      exampleTraceIds: [realTraceIds[i % realTraceIds.length]!],
    }));
    const candidates = failureModes.slice(0, 7).map((fm) => goodCriterion(fm.name, fm.exampleTraceIds));

    const fetchMock = stubFetchSequence([
      chatCompletionReply(model, { failureModes }),
      chatCompletionReply(model, { criteria: candidates }),
    ]);
    const call = makeCall(fetchMock);

    const survivors = await proposeCriteria(realTraces, call);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    const secondBody = JSON.parse(fetchMock.mock.calls[1]![1].body as string);
    expect(firstBody.response_format.json_schema.name).toBe(FAILURE_MODES_SCHEMA.name);
    expect(secondBody.response_format.json_schema.name).toBe(CRITERIA_SCHEMA.name);

    expect(survivors).toHaveLength(7);
    expect(survivors.map((c) => c.id)).toEqual(['c4', 'c5', 'c6', 'c7', 'c8', 'c9', 'c10']);
    const realIdSet = new Set(realTraces.map((t) => t.traceId));
    for (const c of survivors) {
      for (const traceId of c.provenance ?? []) {
        expect(realIdSet.has(traceId)).toBe(true);
      }
    }
  });

  test('drops a criterion whose provenance traceId is not in the corpus, without regenerating it', async () => {
    const failureModes = Array.from({ length: 10 }, (_, i) => ({
      name: `mode_${i}`,
      description: `failure mode ${i}`,
      exampleTraceIds: [realTraceIds[i % realTraceIds.length]!],
    }));
    const candidates = failureModes.map((fm, i) =>
      i === 0 ? goodCriterion(fm.name, ['not-a-real-trace-id']) : goodCriterion(fm.name, fm.exampleTraceIds),
    );

    const fetchMock = stubFetchSequence([
      chatCompletionReply(model, { failureModes }),
      chatCompletionReply(model, { criteria: candidates }),
    ]);
    const call = makeCall(fetchMock);

    const survivors = await proposeCriteria(realTraces, call);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(survivors).toHaveLength(7);
    expect(survivors.some((c) => c.name === 'mode_0')).toBe(false);
  });

  test('regenerates a criterion with a double negative once, then drops it if still bad', async () => {
    const failureModes = Array.from({ length: 10 }, (_, i) => ({
      name: `mode_${i}`,
      description: `failure mode ${i}`,
      exampleTraceIds: [realTraceIds[i % realTraceIds.length]!],
    }));
    const candidates = failureModes.map((fm, i) =>
      i === 0
        ? {
            name: fm.name,
            instructions: 'Is it not true that the answer does not cite a source?',
            escape: 'unclear',
            provenanceTraceIds: fm.exampleTraceIds,
          }
        : goodCriterion(fm.name, fm.exampleTraceIds),
    );
    const regeneratedStillBad = {
      name: 'mode_0',
      instructions: 'Is it not the case that the answer does not mention a source at all?',
      escape: 'unclear',
      provenanceTraceIds: failureModes[0]!.exampleTraceIds,
    };

    const fetchMock = stubFetchSequence([
      chatCompletionReply(model, { failureModes }),
      chatCompletionReply(model, { criteria: candidates }),
      chatCompletionReply(model, { criterion: regeneratedStillBad }),
    ]);
    const call = makeCall(fetchMock);

    const survivors = await proposeCriteria(realTraces, call);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(survivors).toHaveLength(7);
    expect(survivors.some((c) => c.name === 'mode_0')).toBe(false);
  });

  test('keeps a regenerated criterion that becomes valid on the retry', async () => {
    const failureModes = Array.from({ length: 10 }, (_, i) => ({
      name: `mode_${i}`,
      description: `failure mode ${i}`,
      exampleTraceIds: [realTraceIds[i % realTraceIds.length]!],
    }));
    const candidates = failureModes.map((fm, i) =>
      i === 0
        ? {
            name: fm.name,
            instructions: 'Is it not true that the answer does not cite a source?',
            escape: 'unclear',
            provenanceTraceIds: fm.exampleTraceIds,
          }
        : goodCriterion(fm.name, fm.exampleTraceIds),
    );
    const regeneratedGood = {
      name: 'mode_0',
      instructions: 'Does the answer cite a source marker?',
      escape: 'unclear',
      provenanceTraceIds: failureModes[0]!.exampleTraceIds,
    };

    const fetchMock = stubFetchSequence([
      chatCompletionReply(model, { failureModes }),
      chatCompletionReply(model, { criteria: candidates }),
      chatCompletionReply(model, { criterion: regeneratedGood }),
    ]);
    const call = makeCall(fetchMock);

    const survivors = await proposeCriteria(realTraces, call);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(survivors).toHaveLength(7);
    expect(survivors.find((c) => c.name === 'mode_0')?.instructions).toBe('Does the answer cite a source marker?');
  });

  test('throws ShortfallError naming the count when fewer than 7 criteria survive', async () => {
    const failureModes = Array.from({ length: 10 }, (_, i) => ({
      name: `mode_${i}`,
      description: `failure mode ${i}`,
      exampleTraceIds: [realTraceIds[i % realTraceIds.length]!],
    }));
    // Only 5 candidates offered at all, all lint-clean: cannot reach 7 survivors.
    const candidates = failureModes.slice(0, 5).map((fm) => goodCriterion(fm.name, fm.exampleTraceIds));

    const fetchMock = stubFetchSequence([
      chatCompletionReply(model, { failureModes }),
      chatCompletionReply(model, { criteria: candidates }),
    ]);
    const call = makeCall(fetchMock);

    await expect(proposeCriteria(realTraces, call)).rejects.toThrow(
      /only 5 generated criteria survived lint, need 7/,
    );
  });

  test('asks once more for additional distinct failure modes when the first call returns fewer than 10', async () => {
    const firstBatch = Array.from({ length: 6 }, (_, i) => ({
      name: `mode_${i}`,
      description: `failure mode ${i}`,
      exampleTraceIds: [realTraceIds[i % realTraceIds.length]!],
    }));
    const secondBatch = Array.from({ length: 5 }, (_, i) => ({
      name: `extra_mode_${i}`,
      description: `additional failure mode ${i}`,
      exampleTraceIds: [realTraceIds[(i + 6) % realTraceIds.length]!],
    }));
    const allModes = [...firstBatch, ...secondBatch];
    const candidates = allModes.slice(0, 7).map((fm) => goodCriterion(fm.name, fm.exampleTraceIds));

    const fetchMock = stubFetchSequence([
      chatCompletionReply(model, { failureModes: firstBatch }),
      chatCompletionReply(model, { failureModes: secondBatch }),
      chatCompletionReply(model, { criteria: candidates }),
    ]);
    const call = makeCall(fetchMock);

    const survivors = await proposeCriteria(realTraces, call);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(survivors).toHaveLength(7);
  });
});

describe('handleShortfall (unit)', () => {
  test('logs the shortfall message and exits with code 1', () => {
    const err = new ShortfallError(5, 7);
    const log = vi.fn();
    const exit = vi.fn();

    handleShortfall(err, log, exit);

    expect(log).toHaveBeenCalledWith(expect.stringContaining('5'));
    expect(exit).toHaveBeenCalledWith(1);
  });
});

const CRITERIA_JSON_PATH = fileURLToPath(new URL('./data/criteria.json', import.meta.url));

describe('generated spike/data/criteria.json (integration, produced by propose.ts)', () => {
  test('has exactly 10 criteria: c1-c3 fixed, c4-c10 generated with corpus provenance', async () => {
    const raw = await readFile(CRITERIA_JSON_PATH, 'utf8');
    const criteria: Criterion[] = JSON.parse(raw);

    expect(criteria).toHaveLength(10);
    expect(criteria.map((c) => c.id)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9', 'c10']);
    expect(criteria.slice(0, 3)).toEqual(FIXED_CRITERIA);

    const traces = await loadRealTraces();
    const realIdSet = new Set(traces.map((t) => t.traceId));
    for (const c of criteria.slice(3)) {
      expect(lintCriterion(c)).toEqual({ ok: true });
      for (const traceId of c.provenance ?? []) {
        expect(realIdSet.has(traceId)).toBe(true);
      }
    }
  });
});
