import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  safeParseJson,
  type Answer,
  type Case,
  type Criterion,
  type JudgeResponse,
  type JudgeV1,
  type Question,
} from '@vetkit/spec';
import {
  gauntletLength,
  gauntletPositionSwap,
  removeRedundancy,
  spearman,
  type GauntletBiasEvent,
  type PaddingTemplate,
} from './gauntlet-bias.ts';

// Fixture goes through the safeParseJson chokepoint (raw JSON.parse is banned in packages/*/src).
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const PADDING_PATH = join(REPO_ROOT, 'fixtures', 'gauntlet', 'padding.json');
const PADDING_SCHEMA = {
  type: 'object',
  required: ['paddings'],
  properties: {
    description: { type: 'string' },
    paddings: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['id', 'kind', 'text'],
        properties: { id: { type: 'string' }, kind: { type: 'string' }, text: { type: 'string' } },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
} as const;

function loadPaddings(): PaddingTemplate[] {
  const parsed = safeParseJson<{ paddings: PaddingTemplate[] }>(
    readFileSync(PADDING_PATH, 'utf8'),
    PADDING_SCHEMA,
  );
  if (!parsed.ok) throw new Error('invalid fixtures/gauntlet/padding.json');
  return parsed.value.paddings;
}

const BOOL: Criterion = {
  id: 'refund',
  type: 'boolean',
  instructions: 'Did the agent promise a refund?',
  escape: 'The conversation has no refund request.',
  polarity: 'pass_when_true',
  channel: 'outcome',
  provenance: { traceIds: [] },
  wordingHash: 'h',
};

const CHOICE5: Criterion = {
  id: 'tone',
  type: 'choice',
  instructions: 'What is the tone of the final reply?',
  criteria: { a: 'Warm.', b: 'Neutral.', c: 'Curt.', d: 'Hostile.' },
  escape: 'There is no final reply.',
  passWhen: ['a', 'b'],
  polarity: 'pass_when_true',
  channel: 'quality',
  provenance: { traceIds: [] },
  wordingHash: 'h3',
};

const SCORE: Criterion = {
  id: 'quality',
  type: 'score',
  instructions: 'How good is the answer?',
  criteria: ['bad', 'ok', 'good'],
  polarity: 'pass_when_true',
  channel: 'quality',
  provenance: { traceIds: [] },
  wordingHash: 'h2',
};

function mkCase(id: string, state: string): Case {
  return { id, input: { state }, provenance: null, tags: [] };
}

function cases(n: number, prefix = 'c'): Case[] {
  return Array.from({ length: n }, (_, i) =>
    mkCase(`${prefix}${i}`, `user: help ${i}\nassistant: reply ${i}.`),
  );
}

type Decide = (state: string, question: Question) => string;

function choiceAnswer(choice: string, keys: readonly string[]): Answer {
  const probabilities = Object.fromEntries(keys.map((k) => [k, k === choice ? 1 : 0]));
  return { type: 'choice', choice, confidence: 1, probabilities };
}

function fakeJudge(decide: (state: string, question: Question) => Answer): JudgeV1 & {
  calls: { state: string; questions: Record<string, Question> }[];
} {
  const calls: { state: string; questions: Record<string, Question> }[] = [];
  return {
    specVersion: 'v1',
    id: 'fake',
    capabilities: {
      questionTypes: ['boolean', 'choice', 'score'],
      maxStateTokens: 100_000,
      pinned: false,
      transport: 'fake',
      model: 'fake-model',
      // Fake judge reads the raw state; default switched to fenced-v1 after the request-format A/B.
      requestFormat: 'raw',
    },
    calls,
    doJudge(req): Promise<JudgeResponse> {
      calls.push({ state: req.state, questions: req.questions });
      const answers: Record<string, Answer> = {};
      for (const [id, q] of Object.entries(req.questions)) answers[id] = decide(req.state, q);
      return Promise.resolve({
        answers,
        usage: { inputTokens: 1, outputTokens: 1 },
        model: { requested: 'fake-model', resolved: 'fake-1', transport: 'fake', pinned: false },
      });
    },
  };
}

function choiceJudge(decide: Decide): ReturnType<typeof fakeJudge> {
  return fakeJudge((state, q) => {
    const keys = q.type === 'choice' ? Object.keys(q.criteria) : [];
    return choiceAnswer(decide(state, q), keys);
  });
}

/** Boolean judge whose P(yes) is a function of the state. */
function probJudge(p: (state: string) => number): ReturnType<typeof fakeJudge> {
  return fakeJudge((state) => {
    const yes = p(state);
    return {
      type: 'choice',
      choice: yes >= 0.5 ? 'yes' : 'no',
      confidence: 1,
      probabilities: { yes, no: 1 - yes, escape: 0 },
    };
  });
}

const firstOption: Decide = (_s, q) =>
  q.type === 'choice' ? (Object.keys(q.criteria)[0] ?? '') : '';

describe('gauntletPositionSwap', () => {
  test('boolean criterion is re-judged under all 6 orders of {yes, no, escape}', async () => {
    const judge = choiceJudge(() => 'yes');
    const result = await gauntletPositionSwap(BOOL, cases(10), judge);
    expect(result.orders).toHaveLength(6);
    const unique = new Set(result.orders.map((o) => o.join(',')));
    expect(unique.size).toBe(6);
    for (const order of result.orders)
      expect([...order].toSorted((x, y) => x.localeCompare(y))).toEqual(['escape', 'no', 'yes']);
    expect(judge.calls).toHaveLength(60);
    const sent = new Set(
      judge.calls.map((c) => {
        const q = c.questions['refund'];
        return q?.type === 'choice' ? Object.keys(q.criteria).join(',') : '';
      }),
    );
    expect(sent.size).toBe(6);
  });

  test('scripted always-first-option judge → fail, every case inconclusive', async () => {
    const result = await gauntletPositionSwap(BOOL, cases(10), choiceJudge(firstOption), {
      minConsistency: 0.9,
    });
    expect(result.result).toBe('fail');
    expect(result.consistency).toBe(0);
    expect(result.inconclusive).toBe(10);
  });

  test('order-invariant judge → pass with consistency 1', async () => {
    const result = await gauntletPositionSwap(
      BOOL,
      cases(10),
      choiceJudge(() => 'yes'),
      {
        minConsistency: 0.9,
      },
    );
    expect(result.result).toBe('pass');
    expect(result.consistency).toBe(1);
    expect(result.inconclusive).toBe(0);
  });

  test('score criterion → skipped', async () => {
    const judge = choiceJudge(() => 'yes');
    const result = await gauntletPositionSwap(SCORE, cases(10), judge);
    expect(result.result).toBe('skipped');
    expect(judge.calls).toHaveLength(0);
  });

  test('5 sample cases → skipped with reason too_few_samples', async () => {
    const judge = choiceJudge(() => 'yes');
    const result = await gauntletPositionSwap(BOOL, cases(5), judge);
    expect(result.result).toBe('skipped');
    expect(result.reason).toBe('too_few_samples');
    expect(judge.calls).toHaveLength(0);
  });

  test('more than 3 options → identity, reverse and 4 seeded shuffles (capped)', async () => {
    const result = await gauntletPositionSwap(
      CHOICE5,
      cases(10),
      choiceJudge(() => 'a'),
      {
        seed: 3,
      },
    );
    const keys = ['a', 'b', 'c', 'd', 'escape'];
    expect(result.orders).toHaveLength(6);
    expect(result.orders[0]).toEqual(keys);
    expect(result.orders[1]).toEqual(keys.toReversed());
    for (const order of result.orders)
      expect([...order].toSorted((x, y) => x.localeCompare(y))).toEqual(keys);
    expect(result.capped).toBe(true);
    const again = await gauntletPositionSwap(
      CHOICE5,
      cases(10),
      choiceJudge(() => 'a'),
      {
        seed: 3,
      },
    );
    expect(again.orders).toEqual(result.orders);
    expect(result.result).toBe('pass');
  });

  test('a judge failure in one order makes that case inconclusive, not consistent', async () => {
    const base = choiceJudge(() => 'yes');
    const flaky: JudgeV1 = {
      ...base,
      doJudge: (req) => {
        const q = req.questions['refund'];
        const first = q?.type === 'choice' ? Object.keys(q.criteria)[0] : undefined;
        if (req.state.includes('help 0') && first === 'no')
          return Promise.reject(new Error('boom'));
        return base.doJudge(req);
      },
    };
    const result = await gauntletPositionSwap(BOOL, cases(10), flaky);
    expect(result.inconclusive).toBe(1);
    expect(result.consistency).toBeCloseTo(0.9);
    expect(result.result).toBe('pass');
  });

  test('consistency just under 0.90 fails', async () => {
    const judge = choiceJudge((state, q) =>
      state.includes('help 0') || state.includes('help 1') ? firstOption(state, q) : 'yes',
    );
    const result = await gauntletPositionSwap(BOOL, cases(10), judge, { minConsistency: 0.9 });
    expect(result.consistency).toBeCloseTo(0.8);
    expect(result.inconclusive).toBe(2);
    expect(result.result).toBe('fail');
  });
});

describe('padding fixture', () => {
  test('has restated bullets, the MT-Bench repetitive list and filler paragraphs', () => {
    const kinds = loadPaddings().map((p) => p.kind);
    expect(kinds).toContain('restated_bullets');
    expect(kinds).toContain('mt_bench_repetitive_list');
    expect(kinds).toContain('filler_paragraphs');
  });
});

describe('removeRedundancy', () => {
  test('drops duplicate sentences and repeated list items in the final assistant turn', () => {
    const state =
      'user: Refund? Refund?\nassistant: You get a refund. You get a refund. Done.\n- item one\n- item two\n- item one';
    expect(removeRedundancy(state)).toBe(
      'user: Refund? Refund?\nassistant: You get a refund. Done.\n- item one\n- item two',
    );
  });

  test('returns the state unchanged when nothing is redundant', () => {
    const state = 'user: hi\nassistant: One sentence. Another sentence.';
    expect(removeRedundancy(state)).toBe(state);
  });
});

describe('spearman', () => {
  test('ρ = 1 for a monotone relation, with average ranks for ties', () => {
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1);
    expect(spearman([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1);
    expect(spearman([1, 2, 2, 3], [1, 2, 2, 3])).toBeCloseTo(1);
  });

  test('all lengths equal → null', () => {
    expect(spearman([5, 5, 5], [0.1, 0.2, 0.3])).toBeNull();
  });
});

describe('gauntletLength', () => {
  const paddings = loadPaddings();
  const knownFail = Array.from({ length: 5 }, (_, i) =>
    mkCase(`f${i}`, `user: refund please ${i}\nassistant: No refund${'!'.repeat(i)}.`),
  );
  const knownPass = Array.from({ length: 5 }, (_, i) =>
    mkCase(
      `p${i}`,
      `user: refund please ${i}\nassistant: GOOD refund promised${'!'.repeat(i)}. GOOD refund promised${'!'.repeat(i)}.`,
    ),
  );

  test('length-loving judge → fail with paddingFlips > 0', async () => {
    const judge = probJudge((s) => (s.length > 120 ? 0.9 : 0.1));
    const result = await gauntletLength(BOOL, knownFail, knownPass, judge, {
      tolerance: 0.05,
      paddings,
    });
    expect(result.result).toBe('fail');
    expect(result.paddingFlips).toBeGreaterThan(0);
  });

  test('stable judge → pass with no flips', async () => {
    const judge = probJudge((s) => (s.includes('GOOD') ? 0.9 : 0.1));
    const result = await gauntletLength(BOOL, knownFail, knownPass, judge, {
      tolerance: 0.05,
      paddings,
    });
    expect(result.paddingFlips).toBe(0);
    expect(result.truncationFlips).toBe(0);
    expect(result.result).toBe('pass');
  });

  test('pads every known-fail state with every padding template, appended at the end', async () => {
    const judge = probJudge(() => 0.1);
    await gauntletLength(BOOL, knownFail, knownPass, judge, { tolerance: 0.05, paddings });
    for (const f of knownFail) {
      for (const p of paddings) {
        expect(judge.calls.map((c) => c.state)).toContain(f.input.state + p.text);
      }
    }
  });

  test('scripted monotone judge → ρ = 1, logged in an event, result pass with no flips', async () => {
    const events: GauntletBiasEvent[] = [];
    const judge = probJudge((s) => s.length / 10_000);
    const result = await gauntletLength(BOOL, knownFail, knownPass, judge, {
      tolerance: 0.05,
      paddings,
      emit: (e) => events.push(e),
    });
    expect(result.lengthVerdictCorrelation).toBeCloseTo(1);
    expect(result.result).toBe('pass');
    const event = events.find((e) => e.type === 'gauntlet.length_correlation');
    expect(event).toBeDefined();
    expect(event?.rho).toBeCloseTo(1);
    expect(event?.criterionId).toBe('refund');
  });

  test('pass→fail flip on truncation beyond tolerance → fail', async () => {
    const judge = probJudge((s) => ((s.match(/GOOD/g) ?? []).length >= 2 ? 0.9 : 0.1));
    const result = await gauntletLength(BOOL, knownFail, knownPass, judge, {
      tolerance: 0.05,
      paddings,
    });
    expect(result.truncationFlips).toBe(5);
    expect(result.result).toBe('fail');
  });

  test('pass→fail flip within tolerance does not count', async () => {
    const judge = probJudge((s) => ((s.match(/GOOD/g) ?? []).length >= 2 ? 0.52 : 0.48));
    const result = await gauntletLength(BOOL, knownFail, knownPass, judge, {
      tolerance: 0.05,
      paddings,
    });
    expect(result.truncationFlips).toBe(0);
    expect(result.result).toBe('pass');
  });

  test('known-pass states with nothing redundant are skipped for truncation and counted', async () => {
    const plain = Array.from({ length: 5 }, (_, i) =>
      mkCase(`q${i}`, `user: refund ${i}\nassistant: GOOD refund promised ${i}.`),
    );
    const judge = probJudge((s) => (s.includes('GOOD') ? 0.9 : 0.1));
    const result = await gauntletLength(BOOL, knownFail, plain, judge, {
      tolerance: 0.05,
      paddings,
    });
    expect(result.truncationSkipped).toBe(5);
  });

  test('5 sample cases → skipped with reason too_few_samples', async () => {
    const judge = probJudge(() => 0.1);
    const result = await gauntletLength(BOOL, knownFail.slice(0, 3), knownPass.slice(0, 2), judge, {
      tolerance: 0.05,
      paddings,
    });
    expect(result.result).toBe('skipped');
    expect(result.reason).toBe('too_few_samples');
    expect(judge.calls).toHaveLength(0);
  });
});
