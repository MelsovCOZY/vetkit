import { criterionSchema, type GeneratorV1, validateJson } from '@vetkit/spec';
import { describe, expect, test, vi } from 'vitest';
import { computeWordingHash } from '../criteria/load.ts';
import { LINT_RULES, lintCriteria } from '../criteria/lint.ts';
import { createEvents, type DiagEvent } from '../events.ts';
import { proposeCriteria } from './criteria.ts';
import type { FailureMode } from './failure-modes.ts';
import {
  CRITERIA_PROMPT,
  CRITERIA_REPAIR_PROMPT,
  CRITERIA_SCHEMA,
  FAILURE_MODES_PROMPT,
  promptHash,
} from './prompts.ts';

type DoGenerate = GeneratorV1['doGenerate'];

function fakeGenerator(
  value: unknown,
  resolvedModelId: string | null = 'acme/model-1',
): { generator: GeneratorV1; doGenerate: ReturnType<typeof vi.fn<DoGenerate>> } {
  const doGenerate = vi.fn<DoGenerate>(() =>
    Promise.resolve(resolvedModelId === null ? { value } : { value, resolvedModelId }),
  );
  const generator: GeneratorV1 = {
    specVersion: 'v1',
    id: 'fake-gen',
    capabilities: { structured: 'json_schema', streaming: false },
    doGenerate,
  };
  return { generator, doGenerate };
}

const tone: FailureMode = {
  name: 'rude-tone',
  description: 'The assistant is dismissive toward the user.',
  exampleTraceIds: ['t1', 't4'],
};

const facts: FailureMode = {
  name: 'wrong-facts',
  description: 'The assistant states factually incorrect information about the product.',
  exampleTraceIds: ['t2'],
};

function draft(failureMode: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    failureMode,
    instructions: `Does the response show ${failureMode}?`,
    escape: 'The response is missing or empty.',
    polarity: 'pass_when_false',
    channel: 'quality',
    checkable: 'none',
    ...extra,
  };
}

describe('proposeCriteria', () => {
  test('sends one structured call with the criteria schema and prompt', async () => {
    const { generator, doGenerate } = fakeGenerator({ criteria: [draft('rude-tone')] });
    const signal = new AbortController().signal;

    await proposeCriteria({ generator, failureModes: [tone], signal });

    expect(doGenerate).toHaveBeenCalledTimes(1);
    const req = doGenerate.mock.calls[0]?.[0];
    expect(req?.schema?.jsonSchema).toBe(CRITERIA_SCHEMA);
    expect(req?.system).toBe(CRITERIA_PROMPT);
    expect(req?.signal).toBe(signal);
    expect(req?.prompt).toContain('rude-tone');
  });

  test('returns schema-valid candidates with provenance from the failure mode', async () => {
    const { generator } = fakeGenerator({ criteria: [draft('rude-tone')] });

    const { criteria, promptHash: hash } = await proposeCriteria({
      generator,
      failureModes: [tone],
    });

    expect(criteria).toHaveLength(1);
    const c = criteria[0];
    expect(validateJson(c, criterionSchema).ok).toBe(true);
    expect(c).toMatchObject({
      type: 'boolean',
      instructions: 'Does the response show rude-tone?',
      escape: 'The response is missing or empty.',
      polarity: 'pass_when_false',
      channel: 'quality',
      provenance: { traceIds: ['t1', 't4'], generator: `acme/model-1#${hash}` },
    });
    expect(hash).toBe(promptHash(CRITERIA_PROMPT));
    expect(c?.wordingHash).toBe(
      computeWordingHash({
        type: 'boolean',
        instructions: c?.instructions ?? '',
        escape: c?.escape ?? '',
      }),
    );
  });

  test('provenance.generator falls back to the generator id without a resolved model id', async () => {
    const { generator } = fakeGenerator({ criteria: [draft('rude-tone')] }, null);

    const { criteria, promptHash: hash } = await proposeCriteria({
      generator,
      failureModes: [tone],
    });

    expect(criteria[0]?.provenance.generator).toBe(`fake-gen#${hash}`);
  });

  test('candidate ids are unique', async () => {
    const { generator } = fakeGenerator({
      criteria: [draft('rude-tone'), draft('rude-tone', { instructions: 'Is it curt?' })],
    });

    const { criteria } = await proposeCriteria({ generator, failureModes: [tone] });

    expect(new Set(criteria.map((c) => c.id)).size).toBe(2);
  });

  test('a factual failure mode yields checkable factual', async () => {
    const { generator } = fakeGenerator({ criteria: [draft('wrong-facts')] });

    const { criteria } = await proposeCriteria({ generator, failureModes: [facts] });

    expect(criteria[0]?.checkable).toBe('factual');
  });

  test('a tone failure mode is not tagged checkable', async () => {
    const { generator } = fakeGenerator({ criteria: [draft('rude-tone')] });

    const { criteria } = await proposeCriteria({ generator, failureModes: [tone] });

    expect(criteria[0]?.checkable).toBeUndefined();
  });

  test('arithmetic and code failure modes yield math and code', async () => {
    const math: FailureMode = {
      name: 'bad-total',
      description: 'The arithmetic in the order total is wrong.',
      exampleTraceIds: ['t3'],
    };
    const code: FailureMode = {
      name: 'broken-snippet',
      description: 'The generated code does not compile.',
      exampleTraceIds: ['t5'],
    };
    const { generator } = fakeGenerator({
      criteria: [draft('bad-total'), draft('broken-snippet')],
    });

    const { criteria } = await proposeCriteria({ generator, failureModes: [math, code] });

    expect(criteria.map((c) => c.checkable)).toEqual(['math', 'code']);
  });

  test('drafts naming an unknown failure mode are dropped', async () => {
    const { generator } = fakeGenerator({ criteria: [draft('rude-tone'), draft('made-up')] });

    const { criteria } = await proposeCriteria({ generator, failureModes: [tone] });

    expect(criteria).toHaveLength(1);
  });

  test('output that fails the schema is rejected', async () => {
    const { generator } = fakeGenerator({ criteria: [{ failureMode: 'rude-tone' }] });

    await expect(proposeCriteria({ generator, failureModes: [tone] })).rejects.toMatchObject({
      code: 'E_SCHEMA_INVALID',
    });
  });
});

const citation: FailureMode = {
  name: 'missing-citation',
  description: 'The assistant gives a policy answer without citing the policy document.',
  exampleTraceIds: ['t7'],
};

const INVERTED = 'Is a citation of the policy document missing from the response?';
const POSITIVE = 'Does the response cite the policy document?';

/** Answers the first call with `first`, every later call with `later`. */
function sequenceGenerator(
  first: unknown,
  later: unknown,
): { generator: GeneratorV1; doGenerate: ReturnType<typeof vi.fn<DoGenerate>> } {
  let calls = 0;
  const doGenerate = vi.fn<DoGenerate>(() => {
    const value = calls === 0 ? first : later;
    calls += 1;
    return Promise.resolve({ value, resolvedModelId: 'acme/model-1' });
  });
  const generator: GeneratorV1 = {
    specVersion: 'v1',
    id: 'fake-gen',
    capabilities: { structured: 'json_schema', streaming: false },
    doGenerate,
  };
  return { generator, doGenerate };
}

describe('proposeCriteria repair', () => {
  test('a draft rejected by INVERTED_BOOLEAN is re-drafted once and the repair replaces it', async () => {
    const { generator, doGenerate } = sequenceGenerator(
      { criteria: [draft('missing-citation', { instructions: INVERTED })] },
      {
        criteria: [
          draft('missing-citation', { instructions: POSITIVE, polarity: 'pass_when_true' }),
        ],
      },
    );

    const result = await proposeCriteria({ generator, failureModes: [citation] });

    expect(doGenerate).toHaveBeenCalledTimes(2);
    const req = doGenerate.mock.calls[1]?.[0];
    expect(req?.system).toBe(CRITERIA_REPAIR_PROMPT);
    expect(req?.schema?.jsonSchema).toBe(CRITERIA_SCHEMA);
    expect(req?.prompt).toContain(INVERTED);
    expect(req?.prompt).toContain('INVERTED_BOOLEAN');
    expect(result.criteria).toHaveLength(1);
    expect(result.criteria[0]).toMatchObject({
      id: 'missing-citation',
      instructions: POSITIVE,
      polarity: 'pass_when_true',
      provenance: { traceIds: ['t7'] },
    });
    expect(validateJson(result.criteria[0], criterionSchema).ok).toBe(true);
    expect(lintCriteria(result.criteria).filter((i) => i.severity === 'error')).toEqual([]);
    expect(result.repaired).toEqual(['missing-citation']);
    expect(result.unrepaired).toEqual([]);
  });

  test('a repair that still fails lint is not retried again and is reported, not hidden', async () => {
    const inverted = { criteria: [draft('missing-citation', { instructions: INVERTED })] };
    const { generator, doGenerate } = sequenceGenerator(inverted, inverted);
    const events = createEvents();
    const diags: DiagEvent[] = [];
    events.on('diag', (d) => diags.push(d));

    const result = await proposeCriteria({ generator, failureModes: [citation], events });

    expect(doGenerate).toHaveBeenCalledTimes(2);
    expect(result.repaired).toEqual([]);
    expect(result.unrepaired).toEqual(['missing-citation']);
    expect(result.criteria.map((c) => c.id)).toEqual(['missing-citation']);
    expect(diags).toContainEqual(
      expect.objectContaining({ level: 'warn', code: 'CRITERION_REPAIR_FAILED' }),
    );
  });

  test('lint-clean drafts make no repair call', async () => {
    const { generator, doGenerate } = sequenceGenerator(
      { criteria: [draft('missing-citation', { instructions: POSITIVE })] },
      { criteria: [] },
    );

    const result = await proposeCriteria({ generator, failureModes: [citation] });

    expect(doGenerate).toHaveBeenCalledTimes(1);
    expect(result.repaired).toEqual([]);
  });
});

describe('prompt templates', () => {
  test('promptHash is stable across two calls', () => {
    expect(promptHash(CRITERIA_PROMPT)).toBe(promptHash(CRITERIA_PROMPT));
    expect(promptHash(CRITERIA_PROMPT)).toMatch(/^[0-9a-f]{64}$/);
  });

  test('editing a template changes its hash', () => {
    expect(promptHash(`${CRITERIA_PROMPT} `)).not.toBe(promptHash(CRITERIA_PROMPT));
    expect(promptHash(FAILURE_MODES_PROMPT)).not.toBe(promptHash(CRITERIA_PROMPT));
  });

  test('the criteria prompt names every lint rule id', () => {
    for (const rule of LINT_RULES) {
      expect(CRITERIA_PROMPT).toContain(rule.id);
    }
    for (const id of ['INVERTED_BOOLEAN', 'NEGATION_PAIR', 'COMPOUND_LEVEL', 'DEEP_INDIRECTION']) {
      expect(CRITERIA_PROMPT).toContain(id);
    }
  });

  test('the criteria prompt states the core wording rules', () => {
    expect(CRITERIA_PROMPT).toMatch(/atomic/i);
    expect(CRITERIA_PROMPT).toMatch(/escape/i);
    expect(CRITERIA_PROMPT).toMatch(/double negative/i);
    expect(CRITERIA_PROMPT).toContain('outcome');
    expect(CRITERIA_PROMPT).toContain('safety');
    expect(CRITERIA_PROMPT).toContain('quality');
  });

  test('the repair prompt names every lint rule id', () => {
    for (const rule of LINT_RULES) {
      expect(CRITERIA_REPAIR_PROMPT).toContain(rule.id);
    }
  });
});
