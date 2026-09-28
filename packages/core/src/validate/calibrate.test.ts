import { describe, expect, test } from 'vitest';
import type { Case, Criterion, JudgeResponse } from '@vetkit/spec';
import {
  bandCases,
  calibrate,
  correctedPassRate,
  fitThreshold,
  krippendorffAlphaOrdinal,
  repeatTolerance,
  repeatValues,
  splitByHash,
  type CalibrationLabel,
} from './calibrate.ts';

const SEED = 7;

const BOOL: Criterion = {
  id: 'refund',
  type: 'boolean',
  instructions: 'Did the agent promise a refund?',
  escape: undefined,
  polarity: 'pass_when_true',
  channel: 'outcome',
  provenance: { traceIds: [] },
  wordingHash: 'h',
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

const CHOICE: Criterion = {
  id: 'sentiment',
  type: 'choice',
  instructions: 'What is the sentiment?',
  criteria: { positive: 'Positive', neutral: 'Neutral', negative: 'Negative' },
  passWhen: ['positive'],
  escape: undefined,
  polarity: 'pass_when_true',
  channel: 'quality',
  provenance: { traceIds: [] },
  wordingHash: 'h3',
};

interface Row {
  readonly id: string;
  readonly label: 'pass' | 'fail' | 'unknown';
  /** One value = three identical repeats; an array = the repeats themselves. */
  readonly p: number | readonly number[];
  readonly language?: string;
  readonly traceId?: string;
}

const WORDS = [
  'apple',
  'river',
  'stone',
  'cloud',
  'mirror',
  'ticket',
  'garden',
  'violin',
  'harbor',
  'pencil',
  'desert',
  'lantern',
  'orbit',
  'saddle',
  'meadow',
  'copper',
  'fabric',
  'glacier',
  'hammer',
  'island',
  'jacket',
  'kettle',
  'ladder',
  'marble',
  'needle',
  'oyster',
  'parrot',
  'quartz',
  'rocket',
  'silver',
];

let stateCounter = 1;
function uniqueState(): string {
  let x = (stateCounter += 7919) >>> 0;
  const out: string[] = [];
  for (let i = 0; i < 14; i += 1) {
    x = (Math.imul(x, 1_103_515_245) + 12_345) >>> 0;
    out.push(WORDS[(x >>> 8) % WORDS.length] ?? 'x');
  }
  return out.join(' ');
}

let idCounter = 0;
/** Ids that `splitByHash` (seed SEED) puts on the requested side. */
function ids(side: 'train' | 'heldOut', n: number): string[] {
  const out: string[] = [];
  while (out.length < n) {
    const id = `case-${idCounter}`;
    idCounter += 1;
    const split = splitByHash([id], SEED);
    if ((side === 'heldOut') === (split.heldOut.length === 1)) out.push(id);
  }
  return out;
}

/** The single repeated value of a fixture row (fixtures here always use one value). */
function single(p: Row['p']): number {
  return typeof p === 'number' ? p : (p[0] ?? Number.NaN);
}

function rows(
  side: 'train' | 'heldOut',
  n: number,
  label: Row['label'],
  p: Row['p'],
  extra: Partial<Row> = {},
): Row[] {
  return ids(side, n).map((id) => ({ id, label, p, ...extra }));
}

function build(input: readonly Row[]): {
  labels: CalibrationLabel[];
  repeats: Map<string, JudgeResponse[]>;
  cases: Case[];
} {
  const labels = input.map((r) => ({ caseId: r.id, label: r.label }));
  const repeats = new Map(
    input.map((r) => {
      const values = typeof r.p === 'number' ? [r.p, r.p, r.p] : r.p;
      return [
        r.id,
        values.map((probability): JudgeResponse => ({
          answers: { [BOOL.id]: { type: 'boolean', probability } },
          usage: { inputTokens: 1, outputTokens: 1 },
          model: { requested: 'm', resolved: 'm', transport: 't', pinned: false },
        })),
      ];
    }),
  );
  const cases = input.map((r): Case => ({
    id: r.id,
    input: { state: uniqueState() },
    provenance: null,
    tags: [],
    ...(r.language === undefined ? {} : { language: r.language }),
    ...(r.traceId === undefined ? {} : { traceId: r.traceId }),
  }));
  return { labels, repeats, cases };
}

/** Train rows perfectly separated at 0.80: fails at 0.70..0.79, passes at 0.80..0.95. */
function cleanTrain(nPerClass: number, extra: Partial<Row> = {}): Row[] {
  const fails = ids('train', nPerClass).map((id, i) => ({
    id,
    label: 'fail' as const,
    p: 0.7 + (i % 10) / 100,
    ...extra,
  }));
  const passes = ids('train', nPerClass).map((id, i) => ({
    id,
    label: 'pass' as const,
    p: 0.8 + (i % 16) / 100,
    ...extra,
  }));
  return [...fails, ...passes];
}

function judged(answer: JudgeResponse['answers'][string]): JudgeResponse {
  return {
    answers: { [BOOL.id]: answer },
    usage: { inputTokens: 1, outputTokens: 1 },
    model: { requested: 'm', resolved: 'm', transport: 't', pinned: false },
  };
}

function run(input: readonly Row[], criterion: Criterion = BOOL) {
  const { labels, repeats, cases } = build(input);
  return calibrate(criterion, labels, repeats, cases, { seed: SEED });
}

describe('splitByHash', () => {
  test('is deterministic for one seed and splits roughly in half', () => {
    const all = Array.from({ length: 1000 }, (_, i) => `id-${i}`);
    const a = splitByHash(all, 3);
    const b = splitByHash(all, 3);
    expect(a).toEqual(b);
    expect(a.heldOut.length).toBeGreaterThan(400);
    expect(a.heldOut.length).toBeLessThan(600);
    expect(a.train.length + a.heldOut.length).toBe(1000);
  });

  test('a different seed gives a different split', () => {
    const all = Array.from({ length: 200 }, (_, i) => `id-${i}`);
    expect(splitByHash(all, 1).heldOut).not.toEqual(splitByHash(all, 2).heldOut);
  });
});

describe('calibrate: threshold fit and held-out metrics', () => {
  test('fits 0.8 on train and reports TPR/TNR from held-out rows only (train poisoned)', () => {
    const heldOut = [
      ...rows('heldOut', 36, 'pass', 0.9),
      ...rows('heldOut', 4, 'pass', 0.5),
      ...rows('heldOut', 36, 'fail', 0.2),
      ...rows('heldOut', 4, 'fail', 0.9),
    ];
    const result = run([...cleanTrain(40), ...heldOut]);
    expect(Math.abs((result.threshold ?? 0) - 0.8)).toBeLessThanOrEqual(0.02);
    // Train rows are all correct, so any leak would push TPR/TNR above the held-out values.
    expect(result.tpr).toBeCloseTo(0.9, 10);
    expect(result.tnr).toBeCloseTo(0.9, 10);
    expect(result.split.heldOut).toHaveLength(80);
    expect(result.split.train).toHaveLength(80);
    expect(result.status).toBe('calibrated');
    expect(result.reasons).toEqual([]);
  });

  test('fitThreshold maximises balanced accuracy on the 2-decimal grid', () => {
    const scores = [0.1, 0.2, 0.3, 0.55, 0.6, 0.9];
    const labels = [false, false, false, true, true, true];
    const t = fitThreshold(scores, labels, 1);
    expect(t).toBeGreaterThan(0.3);
    expect(t).toBeLessThanOrEqual(0.55);
  });

  test('pass_when_false inverts P(true) before fitting', () => {
    const inverted = [
      ...cleanTrain(40),
      ...rows('heldOut', 35, 'pass', 0.9),
      ...rows('heldOut', 35, 'fail', 0.1),
    ].map((r) => ({ ...r, p: 1 - single(r.p) }));
    const result = run(inverted, { ...BOOL, polarity: 'pass_when_false' });
    expect(Math.abs((result.threshold ?? 0) - 0.8)).toBeLessThanOrEqual(0.02);
    expect(result.tpr).toBe(1);
    expect(result.tnr).toBe(1);
  });
});

describe('calibrate: label floors', () => {
  test('fewer than 100 labelled rows → uncalibrated too_few_labels, no throw', () => {
    const result = run([
      ...cleanTrain(10),
      ...rows('heldOut', 40, 'pass', 0.9),
      ...rows('heldOut', 39, 'fail', 0.1),
    ]);
    expect(result.status).toBe('uncalibrated');
    expect(result.reasons).toContain('too_few_labels');
  });

  test('zero rows of one class → uncalibrated single_class, no throw', () => {
    const result = run([...rows('train', 60, 'pass', 0.9), ...rows('heldOut', 60, 'pass', 0.9)]);
    expect(result.status).toBe('uncalibrated');
    expect(result.reasons).toContain('single_class');
    expect(result.tnr).toBeUndefined();
  });

  test('held-out with exactly 30 pass / 30 fail is not class_too_small', () => {
    const result = run([
      ...cleanTrain(25),
      ...rows('heldOut', 30, 'pass', 0.9),
      ...rows('heldOut', 30, 'fail', 0.1),
    ]);
    expect(result.reasons).not.toContain('class_too_small');
    expect(result.status).toBe('calibrated');
  });

  test('held-out with 30 pass / 29 fail → uncalibrated class_too_small', () => {
    const result = run([
      ...cleanTrain(25),
      ...rows('heldOut', 30, 'pass', 0.9),
      ...rows('heldOut', 29, 'fail', 0.1),
    ]);
    expect(result.status).toBe('uncalibrated');
    expect(result.reasons).toContain('class_too_small');
  });

  test('held-out with no fail rows → single_class_heldout and tnr omitted', () => {
    const result = run([...cleanTrain(40), ...rows('heldOut', 40, 'pass', 0.9)]);
    expect(result.status).toBe('uncalibrated');
    expect(result.reasons).toContain('single_class_heldout');
    expect(result.tnr).toBeUndefined();
  });

  test('unknown labels count toward labelCount but are excluded from fitting', () => {
    const result = run([
      ...cleanTrain(25),
      ...rows('heldOut', 30, 'pass', 0.9),
      ...rows('heldOut', 30, 'fail', 0.1),
      ...rows('heldOut', 10, 'unknown', 0.5),
    ]);
    expect(result.labelCount).toBe(120);
    expect(result.split.heldOut).toHaveLength(60);
  });
});

describe('repeat tolerance and band cases', () => {
  test('repeats {0.60,0.62,0.79} → tolerance 0.19', () => {
    expect(repeatTolerance(new Map([['a', [0.6, 0.62, 0.79]]]))).toBe(0.19);
  });

  test('identical repeats → tolerance floor 0.02', () => {
    expect(repeatTolerance(new Map([['a', [0.5, 0.5, 0.5]]]))).toBe(0.02);
  });

  test('a case with repeats {0.3,0.6,0.9} makes the criterion uncalibrated/unstable', () => {
    const result = run([
      ...cleanTrain(25),
      ...rows('heldOut', 30, 'pass', 0.9),
      ...rows('heldOut', 29, 'fail', 0.1),
      ...rows('heldOut', 1, 'fail', [0.3, 0.6, 0.9]),
    ]);
    expect(result.tolerance).toBeCloseTo(0.6, 10);
    expect(result.status).toBe('uncalibrated');
    expect(result.reasons).toContain('unstable');
  });

  test('bandCases includes means at exactly threshold ± tolerance and excludes just outside', () => {
    const values = new Map([
      ['lo-edge', [0.7, 0.7, 0.7]],
      ['hi-edge', [0.9, 0.9, 0.9]],
      ['lo-out', [0.69, 0.69, 0.69]],
      ['hi-out', [0.91, 0.91, 0.91]],
      ['mid', [0.75, 0.85, 0.8]],
    ]);
    const band = bandCases(values, 0.8, 0.1);
    expect(band).toContain('lo-edge');
    expect(band).toContain('hi-edge');
    expect(band).toContain('mid');
    expect(band).not.toContain('lo-out');
    expect(band).not.toContain('hi-out');
  });

  test('repeatValues takes the expected value for score answers', () => {
    const response: JudgeResponse = {
      answers: {
        quality: {
          type: 'score',
          score: 1.5,
          confidence: 0.2,
          legend: {},
          probabilities: { '0': 0.1, '1': 0.3, '2': 0.6 },
        },
      },
      usage: { inputTokens: 1, outputTokens: 1 },
      model: { requested: 'm', resolved: 'm', transport: 't', pinned: false },
    };
    const values = repeatValues(SCORE, new Map([['a', [response]]]));
    expect(values.get('a')?.[0]).toBeCloseTo(1.5, 10);
  });

  // mol-q4q.13: boolean criteria reach Jev as a {yes, no, escape} choice; P(pass) is P(yes), the
  // same rule run.ts decide uses.
  test('repeatValues takes P(yes) for a boolean criterion answered as a yes/no/escape choice', () => {
    const response = judged({
      type: 'choice',
      choice: 'yes',
      confidence: 0.7,
      probabilities: { yes: 0.7, no: 0.2, escape: 0.1 },
    });
    const values = repeatValues(BOOL, new Map([['a', [response]]]));
    expect(values.get('a')?.[0]).toBeCloseTo(0.7, 10);
  });

  test('repeatValues takes the probability for a boolean criterion answered as a boolean', () => {
    const response = judged({ type: 'boolean', probability: 0.35 });
    const values = repeatValues(BOOL, new Map([['a', [response]]]));
    expect(values.get('a')?.[0]).toBeCloseTo(0.35, 10);
  });

  // mol-q4q.17: a choice answer with empty probabilities falls back to the argmax label, the same
  // rule run.ts decide uses (Number(passWhen.has(choice)), or 1 − v for pass_when_false).
  test('repeatValues falls back to Number(passWhen.has(choice)) for a choice answer with empty probabilities', () => {
    const passResponse: JudgeResponse = {
      answers: {
        sentiment: { type: 'choice', choice: 'positive', confidence: 0.9, probabilities: {} },
      },
      usage: { inputTokens: 1, outputTokens: 1 },
      model: { requested: 'm', resolved: 'm', transport: 't', pinned: false },
    };
    const failResponse: JudgeResponse = {
      answers: {
        sentiment: { type: 'choice', choice: 'negative', confidence: 0.9, probabilities: {} },
      },
      usage: { inputTokens: 1, outputTokens: 1 },
      model: { requested: 'm', resolved: 'm', transport: 't', pinned: false },
    };
    const repeats = new Map([
      ['a', [passResponse]],
      ['b', [failResponse]],
    ]);
    const values = repeatValues(CHOICE, repeats);
    expect(values.get('a')?.[0]).toBe(1);
    expect(values.get('b')?.[0]).toBe(0);

    const inverted: Criterion = { ...CHOICE, polarity: 'pass_when_false' };
    const invertedValues = repeatValues(inverted, repeats);
    expect(invertedValues.get('a')?.[0]).toBe(0);
    expect(invertedValues.get('b')?.[0]).toBe(1);
  });

  test('a boolean criterion calibrated from yes/no/escape choice answers fits a threshold', () => {
    const { labels, repeats, cases } = build([
      ...cleanTrain(25),
      ...rows('heldOut', 30, 'pass', 0.9),
      ...rows('heldOut', 30, 'fail', 0.1),
    ]);
    const asChoice = new Map(
      [...repeats].map(([id, responses]) => [
        id,
        responses.map((r) => {
          const a = r.answers[BOOL.id];
          const p = a?.type === 'boolean' ? a.probability : Number.NaN;
          return judged({
            type: 'choice',
            choice: p >= 0.5 ? 'yes' : 'no',
            confidence: Math.max(p, 1 - p),
            probabilities: { yes: p, no: 1 - p, escape: 0 },
          });
        }),
      ]),
    );
    const result = calibrate(BOOL, labels, asChoice, cases, { seed: SEED });
    expect(result.threshold).toBeGreaterThan(0.7);
    expect(result.threshold).toBeLessThanOrEqual(0.8);
    expect(result.tpr).toBe(1);
    expect(result.tnr).toBe(1);
  });
});

describe('per-language calibration', () => {
  test('en κ 0.9 and kk κ 0.4 → languages [en], language_limited, still calibrated', () => {
    const en = { language: 'en' };
    const kk = { language: 'kk' };
    const result = run([
      ...cleanTrain(25, en),
      ...rows('heldOut', 28, 'pass', 0.9, en),
      ...rows('heldOut', 2, 'pass', 0.5, en),
      ...rows('heldOut', 29, 'fail', 0.1, en),
      ...rows('heldOut', 1, 'fail', 0.9, en),
      ...rows('heldOut', 21, 'pass', 0.9, kk),
      ...rows('heldOut', 9, 'pass', 0.5, kk),
      ...rows('heldOut', 21, 'fail', 0.1, kk),
      ...rows('heldOut', 9, 'fail', 0.9, kk),
    ]);
    expect(result.byLanguage.en?.kappa).toBeCloseTo(0.9, 10);
    expect(result.byLanguage.kk?.kappa).toBeCloseTo(0.4, 10);
    expect(result.byLanguage.en?.status).toBe('calibrated');
    expect(result.byLanguage.kk?.status).toBe('uncalibrated');
    expect(result.languages).toEqual(['en']);
    expect(result.reasons).toContain('language_limited');
    expect(result.status).toBe('calibrated');
  });

  test('cases without a language fall into the und slice', () => {
    const result = run([
      ...cleanTrain(25),
      ...rows('heldOut', 30, 'pass', 0.9),
      ...rows('heldOut', 30, 'fail', 0.1),
    ]);
    expect(result.languages).toEqual(['und']);
    expect(result.byLanguage.und?.labelCount).toBe(110);
  });

  test('no calibrated slice → uncalibrated', () => {
    const kk = { language: 'kk' };
    const result = run([
      ...cleanTrain(25, kk),
      ...rows('heldOut', 21, 'pass', 0.9, kk),
      ...rows('heldOut', 9, 'pass', 0.5, kk),
      ...rows('heldOut', 21, 'fail', 0.1, kk),
      ...rows('heldOut', 9, 'fail', 0.9, kk),
    ]);
    expect(result.languages).toEqual([]);
    expect(result.status).toBe('uncalibrated');
    expect(result.reasons).toContain('language_limited');
  });
});

describe('ECE is report-only', () => {
  test('ECE 0.4 with otherwise-passing metrics → calibrated, reasons empty', () => {
    const result = run([
      ...rows('train', 30, 'pass', 0.2),
      ...rows('train', 30, 'fail', 0),
      ...rows('heldOut', 30, 'pass', 0.2),
      ...rows('heldOut', 30, 'fail', 0),
    ]);
    expect(result.ece).toBeCloseTo(0.4, 10);
    expect(result.status).toBe('calibrated');
    expect(result.reasons).toEqual([]);
    expect(result.reliability).toHaveLength(10);
    const bin = result.reliability[2];
    expect(bin?.n).toBe(30);
    expect(bin?.fracPass).toBe(1);
    expect(bin?.meanP).toBeCloseTo(0.2, 10);
  });
});

describe('clustered standard errors', () => {
  test('10 held-out passes sharing one traceId → clustered se.tpr > naive binomial se', () => {
    const result = run([
      ...cleanTrain(40),
      ...rows('heldOut', 30, 'pass', 0.9),
      ...rows('heldOut', 10, 'pass', 0.5, { traceId: 'shared-trace' }),
      ...rows('heldOut', 40, 'fail', 0.1),
    ]);
    const tpr = result.tpr ?? 0;
    const naive = Math.sqrt((tpr * (1 - tpr)) / 40);
    expect(result.se.tpr).toBeGreaterThan(naive);
  });
});

describe('score criteria', () => {
  test('reports Krippendorff alpha (ordinal) instead of kappa', () => {
    const scoreRows = [
      ...cleanTrain(25),
      ...rows('heldOut', 30, 'pass', 0.9),
      ...rows('heldOut', 30, 'fail', 0.1),
    ];
    const { labels, cases } = build(scoreRows);
    const repeats = new Map(
      scoreRows.map((r) => {
        const p = single(r.p);
        const response: JudgeResponse = {
          answers: {
            quality: {
              type: 'score',
              score: 2 * p,
              confidence: 0.5,
              legend: {},
              probabilities: { '0': 1 - p, '1': 0, '2': p },
            },
          },
          usage: { inputTokens: 1, outputTokens: 1 },
          model: { requested: 'm', resolved: 'm', transport: 't', pinned: false },
        };
        return [r.id, [response, response, response]];
      }),
    );
    const result = calibrate(SCORE, labels, repeats, cases, { seed: SEED });
    expect(result.alpha).toBeCloseTo(1, 10);
    expect(result.kappa).toBeUndefined();
    expect(result.kendallTau).toBeGreaterThan(0);
    expect(Math.abs((result.threshold ?? 0) - 1.6)).toBeLessThanOrEqual(0.02);
  });

  test('krippendorffAlphaOrdinal is 1 on perfect agreement and below 1 otherwise', () => {
    expect(
      krippendorffAlphaOrdinal([
        [0, 0],
        [1, 1],
        [2, 2],
        [1, 1],
      ]),
    ).toBeCloseTo(1, 10);
    expect(
      krippendorffAlphaOrdinal([
        [0, 2],
        [1, 1],
        [2, 0],
        [1, 1],
      ]),
    ).toBeLessThan(1);
  });
});

describe('correctedPassRate (Rogan-Gladen)', () => {
  const input = {
    observedPasses: 60,
    observedN: 100,
    heldOut: { tp: 90, fn: 10, tn: 80, fp: 20 },
    seed: 11,
    resamples: 20_000,
  };

  test('p_obs 0.6, TPR 0.9, TNR 0.8 → θ 0.5714', () => {
    const result = correctedPassRate(input);
    expect(result.valid).toBe(true);
    expect(Math.abs((result.theta ?? 0) - 0.5714)).toBeLessThanOrEqual(0.001);
    const [lo, hi] = result.ci95 ?? [1, 0];
    expect(lo).toBeLessThanOrEqual(result.theta ?? -1);
    expect(hi).toBeGreaterThanOrEqual(result.theta ?? 2);
    expect(hi - lo).toBeGreaterThan(0);
  });

  test('one seed gives an identical CI on two runs', () => {
    expect(correctedPassRate(input).ci95).toEqual(correctedPassRate(input).ci95);
  });

  test('TPR + TNR = 1 → valid:false, theta null', () => {
    const result = correctedPassRate({ ...input, heldOut: { tp: 50, fn: 50, tn: 50, fp: 50 } });
    expect(result.valid).toBe(false);
    expect(result.theta).toBeNull();
  });
});
