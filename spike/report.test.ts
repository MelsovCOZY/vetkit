import { describe, expect, test } from 'vitest';
import {
  checkLabels,
  cohenKappa,
  criterionPasses,
  decideOutcome,
  fitThreshold,
  flipRate,
  krippendorffAlphaNominal,
  medianOfDefined,
  rates,
} from './report.ts';
import type { LabelRow } from './label.ts';

describe('cohenKappa', () => {
  test('perfect agreement -> 1', () => {
    const a = [true, false, true, false];
    const b = [true, false, true, false];
    // po = 4/4 = 1; pA(yes)=0.5, pB(yes)=0.5; pe = 0.5*0.5 + 0.5*0.5 = 0.5
    // kappa = (1 - 0.5) / (1 - 0.5) = 1
    expect(cohenKappa(a, b)).toBeCloseTo(1, 3);
  });

  test('partial agreement -> 0.5 (hand-computed)', () => {
    const a = [true, true, false, false];
    const b = [true, false, false, false];
    // agreements: row1 (T,T) agree, row2 (T,F) disagree, row3/row4 (F,F) agree -> po = 3/4 = 0.75
    // pA(yes) = 2/4 = 0.5, pB(yes) = 1/4 = 0.25
    // pe = 0.5*0.25 + 0.5*0.75 = 0.125 + 0.375 = 0.5
    // kappa = (0.75 - 0.5) / (1 - 0.5) = 0.25 / 0.5 = 0.5
    expect(cohenKappa(a, b)).toBeCloseTo(0.5, 3);
  });

  test('both raters always the same single category -> n/a (chance agreement is 1)', () => {
    const a = [true, true, true];
    const b = [true, true, true];
    // pA = pB = 1 -> pe = 1*1 + 0*0 = 1 -> (po - pe)/(1 - pe) is 0/0, undefined
    expect(cohenKappa(a, b)).toBeNull();
  });
});

describe('krippendorffAlphaNominal', () => {
  test('hand-computed 2-rater example -> ~0.5333 (differs from Cohen kappa on the same data)', () => {
    const rows: (boolean | null)[][] = [
      [true, true],
      [true, false],
      [false, false],
      [false, false],
    ];
    // Pooled marginals across both raters: n_true = 3, n_false = 5, n = 8.
    // Do = (n - sum(o_cc)) / n = (8 - 6) / 8 = 0.25
    // De = (n^2 - sum(n_c^2)) / (n*(n-1)) = (64 - (9 + 25)) / 56 = 30 / 56 = 0.535714...
    // alpha = 1 - 0.25 / 0.535714... = 0.533333...
    expect(krippendorffAlphaNominal(rows)).toBeCloseTo(0.5333, 3);
  });

  test('a unit with fewer than 2 non-null values is excluded from the computation', () => {
    const rows: (boolean | null)[][] = [
      [true, null], // unpairable, excluded
      [true, false],
    ];
    // Only the second row counts: n_true = 1, n_false = 1, n = 2.
    // Do = (2 - 0) / 2 = 1 (the only pair disagrees)
    // De = (4 - (1 + 1)) / (2*1) = 2 / 2 = 1
    // alpha = 1 - 1/1 = 0
    expect(krippendorffAlphaNominal(rows)).toBeCloseTo(0, 6);
  });

  test('every rater agrees on the same single category -> n/a (expected disagreement is 0)', () => {
    const rows: (boolean | null)[][] = [
      [true, true],
      [true, true],
    ];
    expect(krippendorffAlphaNominal(rows)).toBeNull();
  });
});

describe('fitThreshold (Youden J)', () => {
  test('picks the perfectly separating threshold over partially separating ones', () => {
    const scores = [0.9, 0.8, 0.6, 0.4, 0.3, 0.1];
    const labels = [true, true, true, false, false, false];
    // t=0.6 -> predicted true at indices 0,1,2 (scores .9,.8,.6); all match labels exactly:
    //   tpr = 3/3 = 1, tnr = 3/3 = 1, J = 1 (the maximum possible)
    // t=0.4 -> predicted true at indices 0,1,2,3; index 3 is a false positive:
    //   tpr = 1, tnr = 2/3, J = 0.667 (lower)
    expect(fitThreshold(scores, labels)).toBeCloseTo(0.6, 6);
  });
});

describe('rates', () => {
  test('TPR/TNR/accuracy at a given threshold', () => {
    const scores = [0.9, 0.8, 0.6, 0.4, 0.3, 0.1];
    const labels = [true, true, true, false, false, false];
    const result = rates(scores, labels, 0.6);
    expect(result.accuracy).toBeCloseTo(1, 6);
    expect(result.tpr).toBeCloseTo(1, 6);
    expect(result.tnr).toBeCloseTo(1, 6);
  });

  test('TNR is null when there are no negative labels', () => {
    const result = rates([0.9, 0.8], [true, true], 0.5);
    expect(result.tpr).toBeCloseTo(1, 6);
    expect(result.tnr).toBeNull();
  });
});

describe('flipRate', () => {
  test('a trace whose 3 repeats straddle the threshold counts as a flip', () => {
    const repeats = [
      [0.9, 0.8, 0.7], // all >= 0.5, no flip
      [0.4, 0.6, 0.3], // straddles 0.5, flip
    ];
    expect(flipRate(repeats, 0.5)).toBeCloseTo(0.5, 6);
  });
});

describe('criterionPasses', () => {
  const passing = { kappa: 0.7, tpr: 0.9, tnr: 0.9, flipPct: 0.02 };

  test('kappa, TPR, TNR and flip rate all within bars -> passes', () => {
    expect(criterionPasses(passing)).toBe(true);
  });

  test('kappa below 0.6 alone -> not a pass', () => {
    expect(criterionPasses({ ...passing, kappa: 0.59 })).toBe(false);
  });

  test('TPR below 0.8 alone -> not a pass', () => {
    expect(criterionPasses({ ...passing, tpr: 0.79 })).toBe(false);
  });

  test('TNR below 0.8 alone -> not a pass', () => {
    expect(criterionPasses({ ...passing, tnr: 0.79 })).toBe(false);
  });

  test('flip rate above 0.05 alone -> not a pass', () => {
    expect(criterionPasses({ ...passing, flipPct: 0.051 })).toBe(false);
  });

  test('undefined (null) kappa -> not a pass', () => {
    expect(criterionPasses({ ...passing, kappa: null })).toBe(false);
  });
});

describe('medianOfDefined', () => {
  test('excludes null values before taking the median', () => {
    expect(medianOfDefined([0.6, null, 0.4, null, 0.8])).toBeCloseTo(0.6, 6);
  });

  test('all values null -> null', () => {
    expect(medianOfDefined([null, null])).toBeNull();
  });
});

describe('decideOutcome', () => {
  const enoughLabels = { humanTraces: 40, totalLabelRows: 400 };
  const highMedianKappa = 0.6;

  test('7 passing criteria with c1 accuracy >= 0.9 and median kappa >= 0.4 -> GO', () => {
    expect(
      decideOutcome({ ...enoughLabels, c1Accuracy: 0.95, passCount: 7, medianKappa: highMedianKappa }),
    ).toBe('GO');
  });

  test('6 passing criteria -> AMEND', () => {
    expect(
      decideOutcome({ ...enoughLabels, c1Accuracy: 0.95, passCount: 6, medianKappa: highMedianKappa }),
    ).toBe('AMEND');
  });

  test('4 passing criteria (AMEND lower boundary) -> AMEND', () => {
    expect(
      decideOutcome({ ...enoughLabels, c1Accuracy: 0.95, passCount: 4, medianKappa: highMedianKappa }),
    ).toBe('AMEND');
  });

  test('3 passing criteria with median kappa 0.5 -> AMEND (median at/above the 0.4 bar)', () => {
    expect(decideOutcome({ ...enoughLabels, c1Accuracy: 0.95, passCount: 3, medianKappa: 0.5 })).toBe(
      'AMEND',
    );
  });

  test('5 passing criteria with median kappa 0.35 -> NO-GO (median below 0.4 overrides pass count)', () => {
    expect(decideOutcome({ ...enoughLabels, c1Accuracy: 0.95, passCount: 5, medianKappa: 0.35 })).toBe(
      'NO-GO',
    );
  });

  test('c1 accuracy below 0.9 overrides an otherwise-passing count -> NO-GO', () => {
    expect(
      decideOutcome({ ...enoughLabels, c1Accuracy: 0.85, passCount: 8, medianKappa: highMedianKappa }),
    ).toBe('NO-GO');
  });

  test('c1 accuracy 0.89 -> NO-GO even with 8 criteria passing', () => {
    expect(
      decideOutcome({ ...enoughLabels, c1Accuracy: 0.89, passCount: 8, medianKappa: highMedianKappa }),
    ).toBe('NO-GO');
  });

  test('fewer than 30 human-labelled traces -> INCONCLUSIVE regardless of the rest', () => {
    expect(
      decideOutcome({
        humanTraces: 10,
        totalLabelRows: 400,
        c1Accuracy: 0.95,
        passCount: 8,
        medianKappa: highMedianKappa,
      }),
    ).toBe('INCONCLUSIVE');
  });

  test('fewer than 300 total label rows -> INCONCLUSIVE', () => {
    expect(
      decideOutcome({
        humanTraces: 40,
        totalLabelRows: 200,
        c1Accuracy: 0.95,
        passCount: 8,
        medianKappa: highMedianKappa,
      }),
    ).toBe('INCONCLUSIVE');
  });
});

describe('checkLabels', () => {
  function row(overrides: Partial<LabelRow>): LabelRow {
    return {
      traceId: 't1',
      criterionId: 'c1',
      label: 'yes',
      source: 'auto',
      labelledAt: '2026-09-25T00:00:00.000Z',
      baseline: '',
      ...overrides,
    };
  }

  test('counts distinct human-labelled traces separately from total rows', () => {
    const rows: LabelRow[] = [
      row({ traceId: 't1', source: 'human' }),
      row({ traceId: 't1', criterionId: 'c2', source: 'human' }), // same trace, second row
      row({ traceId: 't2', source: 'auto' }),
    ];
    const result = checkLabels(rows);
    expect(result.humanTraces).toBe(1);
    expect(result.totalRows).toBe(3);
    expect(result.ok).toBe(false); // 1 human trace < 30
  });
});
