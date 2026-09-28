import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Answer, Case, Criterion, GeneratorV1, JudgeV1 } from '@vetkit/spec';
import type { CalibrationLabel } from './calibrate.ts';
import { gauntletParaphrase, gauntletPolarity } from './gauntlet-wording.ts';

// ---------- fixtures ----------

const ORIGINAL = 'Does the reply answer the question?';
const CRITERION: Criterion = {
  id: 'answers-question',
  type: 'boolean',
  instructions: ORIGINAL,
  escape: 'The reply is empty or not an answer.',
  polarity: 'pass_when_true',
  channel: 'outcome',
  provenance: { traceIds: [] },
  wordingHash: 'h',
};

const N = 20;
function makeCase(i: number): Case {
  return { id: `c${i}`, input: { state: `state ${i}` }, provenance: {}, tags: [] };
}
const CASES = Array.from({ length: N }, (_, i) => makeCase(i));
const caseIndex = (state: string): number => Number(state.split(' ')[1]);

function choice(yes: number): Answer {
  const probabilities = { yes, no: 1 - yes, escape: 0 };
  return { type: 'choice', choice: yes >= 0.5 ? 'yes' : 'no', confidence: 0.9, probabilities };
}

/**
 * Scripted judge: `script(instructions, caseIndex)` returns P(yes), or undefined to throw
 * (the verdict is then unscored). `instructions` is the base wording, escape suffix removed.
 */
function fakeJudge(
  script: (instructions: string, i: number) => number | undefined,
): JudgeV1 & { seen: string[] } {
  const seen: string[] = [];
  return {
    specVersion: 'v1',
    id: 'fake',
    seen,
    capabilities: {
      questionTypes: ['boolean', 'choice', 'score'],
      maxStateTokens: 100_000,
      pinned: false,
      transport: 'fake',
      model: 'fake-model',
    },
    doJudge: async (req) => {
      const answers: Record<string, Answer> = {};
      for (const [key, q] of Object.entries(req.questions)) {
        const base = q.instructions.split(' Answer "escape" when:')[0] ?? '';
        seen.push(base);
        const p = script(base, caseIndex(req.state));
        if (p === undefined) throw new Error('judge down');
        answers[key] = choice(p);
      }
      return {
        answers,
        usage: { inputTokens: 1, outputTokens: 1 },
        model: {
          requested: 'fake-model',
          resolved: 'fake-model@1',
          transport: 'fake',
          pinned: false,
        },
      };
    },
  };
}

type GenerateRequest = Parameters<GeneratorV1['doGenerate']>[0];
type GenerateResponse = Awaited<ReturnType<GeneratorV1['doGenerate']>>;

function fakeGenerator(
  respond: (req: GenerateRequest) => GenerateResponse,
): GeneratorV1 & { calls: GenerateRequest[] } {
  const calls: GenerateRequest[] = [];
  return {
    specVersion: 'v1',
    id: 'fake-gen',
    calls,
    capabilities: { structured: 'json_schema', streaming: false },
    doGenerate: async (req) => {
      calls.push(req);
      return respond(req);
    },
  };
}

const PARAS = [
  'Is the question answered by the reply?',
  'Does the response address what was asked?',
  'Did the assistant answer the user question?',
  'Is the reply an answer to the question asked?',
];
const paraGen = (paraphrases: string[]): ReturnType<typeof fakeGenerator> =>
  fakeGenerator(() => ({ value: { paraphrases } }));

/** Even cases pass (0.9), odd fail (0.2) under the original wording. */
const origP = (i: number): number => (i % 2 === 0 ? 0.9 : 0.2);

// ---------- gauntletParaphrase ----------

describe('gauntletParaphrase', () => {
  it('passes at agreement 1.0 even when a paraphrase shifts P by 0.3 (spread is diagnostic)', async () => {
    const judge = fakeJudge((ins, i) => {
      if (ins === ORIGINAL) return origP(i);
      // Same decisions, shifted probabilities: 0.9 → 0.6, 0.2 → 0.45.
      return i % 2 === 0 ? 0.6 : 0.45;
    });
    const gen = paraGen(PARAS);
    const out = await gauntletParaphrase(CRITERION, CASES, gen, judge, {
      k: 4,
      minAgreement: 0.9,
    });
    expect(out.result).toBe('pass');
    expect(out.agreement).toEqual([1, 1, 1, 1]);
    expect(out.spread).toBeCloseTo(0.3, 6);
    expect(out.paraphrases).toEqual(PARAS);
    expect(gen.calls).toHaveLength(1);
    expect(gen.calls[0]?.system).toMatch(/^Rewrite the evaluation question/);
    expect(gen.calls[0]?.prompt).toContain(ORIGINAL);
    expect(gen.calls[0]?.schema?.jsonSchema).toBeDefined();
    // Every sample case is judged under every paraphrase.
    for (const p of PARAS) expect(judge.seen.filter((s) => s === p)).toHaveLength(N);
  });

  it('fails when one paraphrase agrees on only 0.85 of the cases', async () => {
    const judge = fakeJudge((ins, i) => {
      if (ins === PARAS[2] && i < 6 && i % 2 === 0) return 0.1; // flips 3 of 20
      return origP(i);
    });
    const out = await gauntletParaphrase(CRITERION, CASES, paraGen(PARAS), judge, {
      k: 4,
      minAgreement: 0.9,
    });
    expect(out.result).toBe('fail');
    expect(out.reasons).toContain('paraphrase');
    expect(out.agreement).toEqual([1, 1, 0.85, 1]);
  });

  it('is skipped when fewer than 3 usable paraphrases remain (identical ones dropped)', async () => {
    const judge = fakeJudge((_ins, i) => origP(i));
    const gen = paraGen([ORIGINAL, `  ${ORIGINAL} `, PARAS[0] ?? '', PARAS[1] ?? '']);
    const out = await gauntletParaphrase(CRITERION, CASES, gen, judge, {
      k: 4,
      minAgreement: 0.9,
    });
    expect(out.result).toBe('skipped');
    expect(out.reasons).toEqual([]);
    expect(out.paraphrases).toEqual([PARAS[0], PARAS[1]]);
  });

  it('is skipped without a generator', async () => {
    const judge = fakeJudge((_ins, i) => origP(i));
    const out = await gauntletParaphrase(CRITERION, CASES, undefined, judge, {
      k: 4,
      minAgreement: 0.9,
    });
    expect(out.result).toBe('skipped');
    expect(out.reason).toBe('no_generator');
    expect(judge.seen).toHaveLength(0);
  });

  it('uses what came when the generator returns fewer than k paraphrases, and notes it', async () => {
    const judge = fakeJudge((_ins, i) => origP(i));
    const out = await gauntletParaphrase(CRITERION, CASES, paraGen(PARAS.slice(0, 3)), judge, {
      k: 4,
      minAgreement: 0.9,
    });
    expect(out.result).toBe('pass');
    expect(out.agreement).toHaveLength(3);
    expect(out.notes).toContain('fewer_paraphrases');
  });

  it('excludes a paraphrase the judge leaves unscored', async () => {
    const judge = fakeJudge((ins, i) => (ins === PARAS[1] ? undefined : origP(i)));
    const out = await gauntletParaphrase(CRITERION, CASES, paraGen(PARAS), judge, {
      k: 4,
      minAgreement: 0.9,
    });
    expect(out.result).toBe('pass');
    expect(out.paraphrases).toEqual([PARAS[0], PARAS[2], PARAS[3]]);
    expect(out.agreement).toEqual([1, 1, 1]);
  });

  it('is skipped when every paraphrase is unscored', async () => {
    const judge = fakeJudge((ins, i) => (ins === ORIGINAL ? origP(i) : undefined));
    const out = await gauntletParaphrase(CRITERION, CASES, paraGen(PARAS), judge, {
      k: 4,
      minAgreement: 0.9,
    });
    expect(out.result).toBe('skipped');
  });

  it('counts a malformed generator response as skipped with a cause, never a throw', async () => {
    const judge = fakeJudge((_ins, i) => origP(i));
    for (const gen of [
      fakeGenerator(() => ({ text: '{"paraphrases": [1, 2' })),
      fakeGenerator(() => ({ value: { paraphrases: 'not an array' } })),
      fakeGenerator(() => {
        throw new Error('generator down');
      }),
    ]) {
      const out = await gauntletParaphrase(CRITERION, CASES, gen, judge, {
        k: 4,
        minAgreement: 0.9,
      });
      expect(out.result).toBe('skipped');
      expect(out.reason).toBe('bad_generator_output');
      expect(typeof out.cause).toBe('string');
    }
  });

  it('parses a text-only generator response through the schema', async () => {
    const judge = fakeJudge((_ins, i) => origP(i));
    const gen = fakeGenerator(() => ({ text: JSON.stringify({ paraphrases: PARAS }) }));
    const out = await gauntletParaphrase(CRITERION, CASES, gen, judge, {
      k: 4,
      minAgreement: 0.9,
    });
    expect(out.result).toBe('pass');
  });
});

// ---------- gauntletPolarity ----------

const NEGATED = 'Does the reply not answer the question?';
const LABELS: CalibrationLabel[] = CASES.map((c, i) => ({
  caseId: c.id,
  label: i % 2 === 0 ? 'pass' : 'fail',
}));
const negGen = (negated: string): ReturnType<typeof fakeGenerator> =>
  fakeGenerator(() => ({ value: { negated } }));

describe('gauntletPolarity', () => {
  it('passes at remapped agreement 0.95 although P_neg ≠ 1 − P_orig', async () => {
    const judge = fakeJudge((ins, i) => {
      if (ins === ORIGINAL) return origP(i);
      if (i === 0) return 0.6; // one pass-labelled case the negated wording gets wrong
      return i % 2 === 0 ? 0.3 : 0.6; // not 0.1 / 0.8
    });
    const out = await gauntletPolarity(CRITERION, CASES, LABELS, negGen(NEGATED), judge, {
      minAgreement: 0.9,
    });
    expect(out.result).toBe('pass');
    expect(out.agreement).toBeCloseTo(0.95, 6);
    expect(out.negatedThreshold).toBeGreaterThan(0.3);
    expect(out.negatedThreshold).toBeLessThanOrEqual(0.6);
    expect(judge.seen.filter((s) => s === NEGATED)).toHaveLength(N);
  });

  it('fails at remapped agreement 0.6', async () => {
    const judge = fakeJudge((ins, i) => {
      if (ins === ORIGINAL) return origP(i);
      const wrong = i < 8; // 4 pass-labelled and 4 fail-labelled cases inverted
      const neg = i % 2 === 0 ? 0.3 : 0.6;
      return wrong ? 0.9 - neg : neg;
    });
    const out = await gauntletPolarity(CRITERION, CASES, LABELS, negGen(NEGATED), judge, {
      minAgreement: 0.9,
    });
    expect(out.result).toBe('fail');
    expect(out.reasons).toContain('polarity');
    expect(out.agreement).toBeCloseTo(0.6, 6);
  });

  it('returns only the hash of the negated wording, never its text', async () => {
    const judge = fakeJudge((ins, i) => (ins === ORIGINAL ? origP(i) : 1 - origP(i)));
    const out = await gauntletPolarity(CRITERION, CASES, LABELS, negGen(NEGATED), judge, {
      minAgreement: 0.9,
    });
    expect(out.result).toBe('pass');
    expect(out.negatedHash).toBe(createHash('sha256').update(NEGATED).digest('hex'));
    expect(JSON.stringify(out)).not.toContain(NEGATED);
    expect(JSON.stringify(out)).not.toContain('not answer');
  });

  it('is skipped when the generated wording carries no negation token', async () => {
    const judge = fakeJudge((_ins, i) => origP(i));
    const out = await gauntletPolarity(
      CRITERION,
      CASES,
      LABELS,
      negGen('Is the reply an answer to the question?'),
      judge,
      { minAgreement: 0.9 },
    );
    expect(out.result).toBe('skipped');
    expect(out.reason).toBe('no_negation');
  });

  it('is skipped without a generator or on malformed generator output', async () => {
    const judge = fakeJudge((_ins, i) => origP(i));
    const none = await gauntletPolarity(CRITERION, CASES, LABELS, undefined, judge, {
      minAgreement: 0.9,
    });
    expect(none.result).toBe('skipped');
    expect(none.reason).toBe('no_generator');
    const bad = await gauntletPolarity(
      CRITERION,
      CASES,
      LABELS,
      fakeGenerator(() => ({ text: 'nope' })),
      judge,
      { minAgreement: 0.9 },
    );
    expect(bad.result).toBe('skipped');
    expect(bad.reason).toBe('bad_generator_output');
    expect(typeof bad.cause).toBe('string');
  });
});
