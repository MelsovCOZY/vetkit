import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Case, Criterion } from '@vetkit/spec';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadCases } from './cases/load.ts';
import { loadCriteria } from './criteria/load.ts';
import {
  DEFAULT_CALLS_PER_MINUTE,
  estimateRun,
  estimateValidate,
  type EstimatePricing,
} from './estimate.ts';
import { buildRequest, cacheKey } from './judge/request.ts';
import { CALIBRATION_MIN_REPEATS } from './validate/calibrate.ts';

// The criteria fixture project: three criteria (boolean, choice, score) and two cases.
const criteriaFile = fileURLToPath(
  new URL('../../../fixtures/criteria/valid.yaml', import.meta.url),
);
const casesDir = fileURLToPath(new URL('../../../fixtures/criteria/cases/valid', import.meta.url));
const MODEL = 'fake-model';

const pricing: EstimatePricing = {
  inputPerMTok: 0.042,
  outputPerMTok: 0,
  source: 'test price row',
  asOf: '2026-09-25',
};

let criteria: Criterion[];
let cases: Case[];

beforeAll(async () => {
  const c = await loadCriteria(criteriaFile);
  const k = await loadCases(casesDir);
  if (!c.ok || !k.ok) throw new Error('fixture failed to load');
  criteria = c.criteria;
  cases = k.cases;
});

function expectedTokens(evalCase: Case): number {
  const req = buildRequest(evalCase, criteria);
  return Math.ceil((req.state.length + JSON.stringify(req.questions).length) / 4);
}

describe('estimateRun', () => {
  it('counts one call per case and chars/4 input tokens over state + questions', async () => {
    const est = await estimateRun({ criteria, cases, model: MODEL });
    expect(est.cases).toBe(2);
    expect(est.criteria).toBe(3);
    expect(est.calls).toBe(2);
    expect(est.cacheHits).toBe(0);
    expect(est.inputTokens).toBe(cases.reduce((sum, c) => sum + expectedTokens(c), 0));
  });

  it('prices input tokens from the given pricing row and carries its source and asOf', async () => {
    const est = await estimateRun({ criteria, cases, model: MODEL, pricing });
    expect(est.cost).toEqual({
      usd: (est.inputTokens * 0.042) / 1_000_000,
      source: 'test price row',
      asOf: '2026-09-25',
    });
  });

  it("reports cost 'unknown' without a pricing row", async () => {
    const est = await estimateRun({ criteria, cases, model: MODEL });
    expect(est.cost).toBe('unknown');
  });

  it("reports cost 'unknown' when output is priced (output tokens are not estimated)", async () => {
    const est = await estimateRun({
      criteria,
      cases,
      model: MODEL,
      pricing: { ...pricing, outputPerMTok: 1 },
    });
    expect(est.cost).toBe('unknown');
  });

  it('computes minutes at the default 25 calls/min, or at a given rate', async () => {
    expect(DEFAULT_CALLS_PER_MINUTE).toBe(25);
    const est = await estimateRun({ criteria, cases, model: MODEL });
    expect(est.callsPerMinute).toBe(25);
    expect(est.minutes).toBeCloseTo(2 / 25);
    const fast = await estimateRun({ criteria, cases, model: MODEL, callsPerMinute: 1 });
    expect(fast.minutes).toBe(2);
  });

  it('zero cases estimate zero calls, tokens and minutes', async () => {
    const est = await estimateRun({ criteria, cases: [], model: MODEL, pricing });
    expect(est).toMatchObject({ cases: 0, calls: 0, inputTokens: 0, minutes: 0 });
  });

  it('subtracts cached cases (a .vet/cache hit is 0 calls) and names the hit count', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'vetkit-estimate-'));
    const [first, second] = cases;
    if (first === undefined || second === undefined) throw new Error('fixture needs two cases');
    writeFileSync(join(cacheDir, `${cacheKey(first, criteria, MODEL)}.json`), '{}');
    const est = await estimateRun({ criteria, cases, model: MODEL, cacheDir });
    expect(est.cacheHits).toBe(1);
    expect(est.calls).toBe(1);
    expect(est.inputTokens).toBe(expectedTokens(second));
  });

  it('a cache entry for another model is not a hit', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'vetkit-estimate-'));
    const [first] = cases;
    if (first === undefined) throw new Error('fixture needs a case');
    writeFileSync(join(cacheDir, `${cacheKey(first, criteria, 'other-model')}.json`), '{}');
    const est = await estimateRun({ criteria, cases, model: MODEL, cacheDir });
    expect(est.cacheHits).toBe(0);
  });

  it('a missing cache dir is no hits and no warning', async () => {
    const cacheDir = join(mkdtempSync(join(tmpdir(), 'vetkit-estimate-')), 'absent');
    const est = await estimateRun({ criteria, cases, model: MODEL, cacheDir });
    expect(est.cacheHits).toBe(0);
    expect(est.warnings).toEqual([]);
  });

  it('an unreadable cache dir is treated as no hits, with a warning', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vetkit-estimate-'));
    const notADir = join(root, 'file');
    writeFileSync(notADir, 'x');
    const est = await estimateRun({ criteria, cases, model: MODEL, cacheDir: notADir });
    expect(est.cacheHits).toBe(0);
    expect(est.calls).toBe(2);
    expect(est.warnings.some((w) => w.includes(notADir))).toBe(true);
  });

  it('makes no network call', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (): never => {
      throw new Error('fetch must not be called');
    };
    try {
      const est = await estimateRun({ criteria, cases, model: MODEL, pricing });
      expect(est.calls).toBe(2);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('estimateValidate', () => {
  it('validate multipliers: repeats and each gauntlet pack size multiply the run calls', async () => {
    const est = await estimateValidate({
      criteria,
      cases,
      model: MODEL,
      pricing,
      repeats: 3,
      gauntletPackSizes: { bias: 4, controls: 5 },
    });
    const base = est.base;
    const byName = Object.fromEntries(est.parts.map((p) => [p.name, p]));
    expect(byName['calibration']).toMatchObject({
      calls: base.calls * 3,
      inputTokens: base.inputTokens * 3,
    });
    expect(byName['gauntlet-bias']).toMatchObject({ calls: base.calls * 4 });
    expect(byName['gauntlet-controls']).toMatchObject({ calls: base.calls * 5 });
    expect(est.total.calls).toBe(base.calls * 12);
    expect(est.total.minutes).toBeCloseTo((base.calls * 12) / 25);
    expect(est.total.cost).toMatchObject({ usd: (base.inputTokens * 12 * 0.042) / 1_000_000 });
  });

  it("validate multipliers: an absent constant makes that part (and the total) 'unknown'", async () => {
    const est = await estimateValidate({ criteria, cases, model: MODEL, pricing, repeats: 3 });
    const byName = Object.fromEntries(est.parts.map((p) => [p.name, p]));
    expect(byName['calibration']?.calls).toBe(est.base.calls * 3);
    expect(byName['gauntlet-bias']).toMatchObject({
      calls: 'unknown',
      inputTokens: 'unknown',
      cost: 'unknown',
      minutes: 'unknown',
    });
    expect(byName['gauntlet-controls']?.calls).toBe('unknown');
    expect(est.total.calls).toBe('unknown');
    expect(est.total.cost).toBe('unknown');
  });

  it('validate uses the calibration repeat count when repeats is not given', async () => {
    const est = await estimateValidate({ criteria, cases, model: MODEL, pricing });
    const calibration = est.parts.find((p) => p.name === 'calibration');
    expect(calibration?.calls).toBe(est.base.calls * CALIBRATION_MIN_REPEATS);
    expect(calibration?.cost).toMatchObject({ source: pricing.source });
  });

  it('validate subtracts cached cases from the base before multiplying', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'vetkit-estimate-'));
    mkdirSync(cacheDir, { recursive: true });
    const [first] = cases;
    if (first === undefined) throw new Error('fixture needs a case');
    writeFileSync(join(cacheDir, `${cacheKey(first, criteria, MODEL)}.json`), '{}');
    const est = await estimateValidate({ criteria, cases, model: MODEL, cacheDir, repeats: 3 });
    expect(est.base.cacheHits).toBe(1);
    expect(est.parts.find((p) => p.name === 'calibration')?.calls).toBe(3);
  });
});
