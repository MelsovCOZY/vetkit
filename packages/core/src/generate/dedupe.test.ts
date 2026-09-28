import type { Answer, Criterion, JudgeV1, Question } from '@vetkit/spec';
import { describe, expect, test, vi } from 'vitest';
import { computeWordingHash } from '../criteria/load.ts';
import { dedupeCriteria } from './dedupe.ts';

type DoJudge = JudgeV1['doJudge'];
type JudgeRequest = Parameters<DoJudge>[0];

interface CandidateExtra {
  readonly channel?: Criterion['channel'];
  readonly provenance?: Criterion['provenance'];
}

function candidate(id: string, instructions: string, extra: CandidateExtra = {}): Criterion {
  const escape = 'The response is missing or empty.';
  return {
    id,
    type: 'boolean',
    instructions,
    escape,
    polarity: 'pass_when_false',
    channel: 'quality',
    provenance: { traceIds: [`${id}-trace`], generator: 'acme/model-1#hash' },
    wordingHash: computeWordingHash({ type: 'boolean', instructions, escape }),
    ...extra,
  };
}

const DISSIMILAR = [
  'Does the response use sarcasm toward the user?',
  "Does the response reveal another customer's email address?",
  'Does the response describe a product feature absent from the catalogue?',
  "Does the response change the subject away from the user's question?",
  "Does the response use a language other than the language of the user's message?",
];

const REFUND = 'Does the response state a refund amount that differs from the order total?';
const REFUND_DUP =
  'Does the response state a refund amount that differs from the order total shown?';

interface FakeJudge {
  readonly judge: JudgeV1;
  readonly doJudge: ReturnType<typeof vi.fn<DoJudge>>;
}

/** Answers every choice question with its first non-'none' option at `probability`. */
function fakeJudge(probability = 0.9, pick: 'first' | 'none' = 'first'): FakeJudge {
  const doJudge = vi.fn<DoJudge>((req: JudgeRequest) => {
    const answers: Record<string, Answer> = {};
    for (const [key, q] of Object.entries(req.questions)) {
      if (q.type !== 'choice') continue;
      const keys = Object.keys(q.criteria);
      const choice = pick === 'none' ? 'none' : (keys.find((k) => k !== 'none') ?? 'none');
      const probabilities = Object.fromEntries(
        keys.map((k) => [k, k === choice ? probability : (1 - probability) / (keys.length - 1)]),
      );
      answers[key] = { type: 'choice', choice, confidence: probability, probabilities };
    }
    return Promise.resolve({
      answers,
      usage: { inputTokens: 1, outputTokens: 1 },
      model: { requested: 'jev', resolved: 'jev-1.13', transport: 'fake', pinned: false },
    });
  });
  const judge: JudgeV1 = {
    specVersion: 'v1',
    id: 'fake-jev',
    capabilities: {
      questionTypes: ['boolean', 'choice', 'score'],
      maxStateTokens: 32_000,
      pinned: false,
      transport: 'fake',
      model: 'jev',
    },
    doJudge,
  };
  return { judge, doJudge };
}

function choiceQuestions(
  req: JudgeRequest | undefined,
): Array<Extract<Question, { type: 'choice' }>> {
  return Object.values(req?.questions ?? {}).filter(
    (q): q is Extract<Question, { type: 'choice' }> => q.type === 'choice',
  );
}

describe('dedupeCriteria', () => {
  test('5 dissimilar candidates: zero Jev calls, all kept', async () => {
    const { judge, doJudge } = fakeJudge();
    const candidates = DISSIMILAR.map((text, i) => candidate(`c${i}`, text));

    const result = await dedupeCriteria({ judge, candidates });

    expect(doJudge).not.toHaveBeenCalled();
    expect(result.kept.map((c) => c.id)).toEqual(candidates.map((c) => c.id));
    expect(result.duplicates).toEqual([]);
  });

  test('one near-duplicate pair among 5: one call with only that pair and a none escape; duplicate merged', async () => {
    const { judge, doJudge } = fakeJudge(0.9);
    const candidates = [
      candidate('refund', REFUND, { provenance: { traceIds: ['t1', 't2'] } }),
      ...DISSIMILAR.slice(0, 3).map((text, i) => candidate(`c${i}`, text)),
      candidate('refund-2', REFUND_DUP, { provenance: { traceIds: ['t2', 't3'] } }),
    ];

    const result = await dedupeCriteria({ judge, candidates });

    expect(doJudge).toHaveBeenCalledTimes(1);
    const req = doJudge.mock.calls[0]?.[0];
    expect(req?.state).toContain(REFUND);
    expect(req?.state).toContain(REFUND_DUP);
    for (const text of DISSIMILAR.slice(0, 3)) expect(req?.state).not.toContain(text);
    const questions = choiceQuestions(req);
    expect(questions).toHaveLength(1);
    expect(Object.keys(questions[0]?.criteria ?? {})).toContain('none');
    expect(Object.keys(questions[0]?.criteria ?? {})).toContain('refund');

    expect(result.kept.map((c) => c.id)).toEqual(['refund', 'c0', 'c1', 'c2']);
    expect(result.duplicates).toEqual([
      expect.objectContaining({ id: 'refund-2', duplicateOf: 'refund' }),
    ]);
    const refund = result.kept.find((c) => c.id === 'refund');
    expect(refund?.provenance.traceIds).toEqual(['t1', 't2', 't3']);
  });

  test('a duplicate judged below probability 0.8 is kept', async () => {
    const { judge } = fakeJudge(0.7);
    const candidates = [candidate('refund', REFUND), candidate('refund-2', REFUND_DUP)];

    const result = await dedupeCriteria({ judge, candidates });

    expect(result.kept.map((c) => c.id)).toEqual(['refund', 'refund-2']);
    expect(result.duplicates).toEqual([]);
  });

  test('Jev choosing the none escape keeps both', async () => {
    const { judge, doJudge } = fakeJudge(0.95, 'none');
    const candidates = [candidate('refund', REFUND), candidate('refund-2', REFUND_DUP)];

    const result = await dedupeCriteria({ judge, candidates });

    expect(doJudge).toHaveBeenCalledTimes(1);
    expect(result.kept).toHaveLength(2);
  });

  test('identical wording in different channels is never sent to Jev', async () => {
    const { judge, doJudge } = fakeJudge();
    const candidates = [
      candidate('a', REFUND, { channel: 'outcome' }),
      candidate('b', REFUND, { channel: 'quality' }),
    ];

    const result = await dedupeCriteria({ judge, candidates });

    expect(doJudge).not.toHaveBeenCalled();
    expect(result.kept).toHaveLength(2);
  });

  test('a large similar group is batched: at most one call per 50 candidates, ≤50 options each', async () => {
    const { judge, doJudge } = fakeJudge(0.9, 'none');
    const candidates = Array.from({ length: 60 }, (_, i) => candidate(`r${i}`, `${REFUND} (${i})`));

    await dedupeCriteria({ judge, candidates });

    expect(doJudge.mock.calls.length).toBeGreaterThan(0);
    expect(doJudge.mock.calls.length).toBeLessThanOrEqual(Math.ceil(60 / 50));
    for (const [req] of doJudge.mock.calls) {
      for (const q of choiceQuestions(req)) {
        expect(Object.keys(q.criteria).length).toBeLessThanOrEqual(50);
        expect(Object.keys(q.criteria)).toContain('none');
      }
    }
  });
});
