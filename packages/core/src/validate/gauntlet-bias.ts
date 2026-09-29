// Gauntlet C: option-order (position swap) consistency and length padding/truncation checks for
// one criterion (arXiv 2406.07791, 2306.05685, 2404.04475).
// Judges through judgeCase with the cache bypassed; the only side effect is the injected `emit`.
// Results feed the lock keys `gauntlet.position_swap` and `gauntlet.length`.
import type { Answer, Case, Criterion, GauntletOutcome, JudgeV1 } from '@vetkit/spec';
import { judgeCase } from '../judge/request.ts';

/** Position consistency floor (vetkit choice; re-tune after the JS spike). */
const DEFAULT_MIN_CONSISTENCY = 0.9;
const MIN_SAMPLES = 10;
/**
 * Option orders judged per sample case in the position-swap gauntlet, at most: all n! orders
 * for n ≤ 3 option keys, else 6. The length gauntlet's calls depend on its padding pack.
 */
export const POSITION_SWAP_MAX_ORDERS = 6;
const ESCAPE_KEY = 'escape';
const EPSILON = 1e-9;

export type GauntletBiasSkipReason = 'too_few_samples' | 'score_criterion';

export interface GauntletBiasEvent {
  readonly type: 'gauntlet.length_correlation';
  readonly criterionId: string;
  readonly rho: number | null;
  readonly n: number;
}

export interface PositionSwapOptions {
  readonly minConsistency?: number;
  readonly seed?: number;
  readonly signal?: AbortSignal;
}

export interface PositionSwapResult {
  readonly result: GauntletOutcome;
  /** Share of sample cases whose decision is identical under every order. */
  readonly consistency: number;
  /** Cases with an order-flipped disagreement or a failed judgment in some order. */
  readonly inconclusive: number;
  readonly orders: readonly (readonly string[])[];
  /** True when there were more permutations than the 6 orders judged. */
  readonly capped: boolean;
  readonly reason?: GauntletBiasSkipReason;
}

export interface PaddingTemplate {
  readonly id: string;
  readonly kind: string;
  readonly text: string;
}

export interface LengthOptions {
  /** Criterion repeat tolerance (calibrate); a truncation flip counts only when |ΔP| exceeds it. */
  readonly tolerance: number;
  /** Content-free paddings, e.g. fixtures/gauntlet/padding.json `paddings`. */
  readonly paddings: readonly PaddingTemplate[];
  /** Boolean pass threshold on P(pass). Default 0.5. */
  readonly threshold?: number;
  readonly emit?: (event: GauntletBiasEvent) => void;
  readonly signal?: AbortSignal;
}

export interface LengthResult {
  readonly result: GauntletOutcome;
  readonly paddingFlips: number;
  readonly truncationFlips: number;
  /** Spearman ρ of state length vs P(pass) over the sample and its padded variants; never gates. */
  readonly lengthVerdictCorrelation: number | null;
  /** Known-pass states with nothing redundant to remove. */
  readonly truncationSkipped: number;
  /** States whose judgment failed or escaped; never counted as flips. */
  readonly inconclusive: number;
  readonly reason?: GauntletBiasSkipReason;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Option keys as buildRequest sends them: boolean → {yes, no, escape}; choice → keys (+ escape). */
function optionKeys(criterion: Criterion): string[] {
  if (criterion.type === 'boolean') return ['yes', 'no', ESCAPE_KEY];
  if (criterion.type !== 'choice') return [];
  const keys = Object.keys(criterion.criteria);
  return keys.includes(String(criterion.escape)) ? keys : [...keys, ESCAPE_KEY];
}

function permutations(keys: readonly string[]): string[][] {
  if (keys.length <= 1) return [[...keys]];
  return keys.flatMap((k, i) =>
    permutations([...keys.slice(0, i), ...keys.slice(i + 1)]).map((rest) => [k, ...rest]),
  );
}

function shuffle(keys: readonly string[], rand: () => number): string[] {
  const out = [...keys];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j] ?? '', out[i] ?? ''];
  }
  return out;
}

function enumerateOrders(keys: readonly string[], seed: number): string[][] {
  if (keys.length <= 3) return permutations(keys);
  const orders = [[...keys], keys.toReversed()];
  const seen = new Set(orders.map((o) => o.join('\u0000')));
  const rand = mulberry32(seed);
  // n ≥ 4 gives ≥ 24 permutations, so 4 distinct shuffles always exist; the bound is a safety net.
  for (let tries = 0; orders.length < POSITION_SWAP_MAX_ORDERS && tries < 1000; tries += 1) {
    const order = shuffle(keys, rand);
    const id = order.join('\u0000');
    if (seen.has(id)) continue;
    seen.add(id);
    orders.push(order);
  }
  return orders;
}

function choiceDecision(answer: Answer | undefined): string | undefined {
  return answer?.type === 'choice' ? answer.choice : undefined;
}

function swapSkipped(reason: GauntletBiasSkipReason): PositionSwapResult {
  return { result: 'skipped', consistency: 0, inconclusive: 0, orders: [], capped: false, reason };
}

export async function gauntletPositionSwap(
  criterion: Criterion,
  sampleCases: readonly Case[],
  judge: JudgeV1,
  options: PositionSwapOptions = {},
): Promise<PositionSwapResult> {
  const minConsistency = options.minConsistency ?? DEFAULT_MIN_CONSISTENCY;
  if (criterion.type === 'score') return swapSkipped('score_criterion');
  if (sampleCases.length < MIN_SAMPLES) return swapSkipped('too_few_samples');

  const keys = optionKeys(criterion);
  const orders = enumerateOrders(keys, options.seed ?? 0);
  let consistent = 0;
  for (const evalCase of sampleCases) {
    const decisions = new Set<string | undefined>();
    for (const order of orders) {
      // No cache: every order must reach the judge.
      const [verdict] = await judgeCase({
        judge,
        case: evalCase,
        criteria: [criterion],
        optionOrder: { [criterion.id]: order },
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      decisions.add(verdict?.status === 'ok' ? choiceDecision(verdict.answer) : undefined);
    }
    if (decisions.size === 1 && !decisions.has(undefined)) consistent += 1;
  }
  const consistency = consistent / sampleCases.length;
  return {
    result: consistency + EPSILON < minConsistency ? 'fail' : 'pass',
    consistency,
    inconclusive: sampleCases.length - consistent,
    orders,
    capped: permutationCount(keys.length) > orders.length,
  };
}

function permutationCount(n: number): number {
  let out = 1;
  for (let i = 2; i <= n; i += 1) out *= i;
  return out;
}

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;
const FINAL_ASSISTANT = /^assistant\s*:\s*/gim;

/**
 * Drops exact repeats inside the final assistant turn (the text after the last `assistant:` line
 * marker, or the whole state when there is none): repeated list items and duplicate sentences.
 * Returns the state unchanged when nothing is redundant.
 */
export function removeRedundancy(state: string): string {
  let start = 0;
  for (const m of state.matchAll(FINAL_ASSISTANT)) start = m.index + m[0].length;
  const head = state.slice(0, start);
  const lines = state.slice(start).split('\n');

  const seenItems = new Set<string>();
  const seenSentences = new Set<string>();
  let dropped = 0;
  const kept: string[] = [];
  for (const line of lines) {
    if (LIST_ITEM.test(line)) {
      const item = line.replace(LIST_ITEM, '').trim();
      if (seenItems.has(item)) {
        dropped += 1;
        continue;
      }
      seenItems.add(item);
      kept.push(line);
      continue;
    }
    const sentences = line.split(/(?<=[.!?])\s+/);
    const out: string[] = [];
    for (const sentence of sentences) {
      const key = sentence.trim();
      if (key.length > 0 && seenSentences.has(key)) {
        dropped += 1;
        continue;
      }
      if (key.length > 0) seenSentences.add(key);
      out.push(sentence);
    }
    kept.push(out.join(' '));
  }
  return dropped === 0 ? state : head + kept.join('\n');
}

function ranks(values: readonly number[]): number[] {
  const order = values.map((v, i) => [v, i] as const).toSorted((a, b) => a[0] - b[0]);
  const out = Array.from({ length: values.length }, () => 0);
  for (let i = 0; i < order.length;) {
    let j = i;
    while (j + 1 < order.length && order[j + 1]?.[0] === order[i]?.[0]) j += 1;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) out[order[k]?.[1] ?? 0] = avg;
    i = j + 1;
  }
  return out;
}

/** Spearman ρ with average ranks for ties; null when either side is constant or n < 2. */
export function spearman(xs: readonly number[], ys: readonly number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;
  const rx = ranks(xs.slice(0, n));
  const ry = ranks(ys.slice(0, n));
  const mx = rx.reduce((s, v) => s + v, 0) / n;
  const my = ry.reduce((s, v) => s + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = (rx[i] ?? 0) - mx;
    const dy = (ry[i] ?? 0) - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

interface Judged {
  readonly p: number;
  readonly pass: boolean;
}

function escapeKey(criterion: Criterion): string {
  if (criterion.type !== 'choice') return ESCAPE_KEY;
  const escape = String(criterion.escape);
  return Object.hasOwn(criterion.criteria, escape) ? escape : ESCAPE_KEY;
}

/** P(pass) and the pass decision, mirroring run.ts; undefined on failure or escape. */
function grade(
  criterion: Criterion,
  answer: Answer | undefined,
  threshold: number,
): Judged | undefined {
  if (answer === undefined) return undefined;
  if (criterion.type === 'choice') {
    if (answer.type !== 'choice' || answer.choice === escapeKey(criterion)) return undefined;
    const passWhen = new Set(criterion.passWhen ?? []);
    const p = Object.entries(answer.probabilities)
      .filter(([key]) => passWhen.has(key))
      .reduce((sum, [, v]) => sum + v, 0);
    return { p, pass: passWhen.has(answer.choice) };
  }
  let yes: number;
  if (answer.type === 'boolean') yes = answer.probability;
  else if (answer.type === 'choice') {
    if (answer.choice === ESCAPE_KEY) return undefined;
    yes = answer.probabilities['yes'] ?? 0;
  } else return undefined;
  const p = criterion.polarity === 'pass_when_true' ? yes : 1 - yes;
  return { p, pass: p >= threshold };
}

function lengthSkipped(reason: GauntletBiasSkipReason): LengthResult {
  return {
    result: 'skipped',
    paddingFlips: 0,
    truncationFlips: 0,
    lengthVerdictCorrelation: null,
    truncationSkipped: 0,
    inconclusive: 0,
    reason,
  };
}

export async function gauntletLength(
  criterion: Criterion,
  knownFail: readonly Case[],
  knownPass: readonly Case[],
  judge: JudgeV1,
  options: LengthOptions,
): Promise<LengthResult> {
  if (criterion.type === 'score') return lengthSkipped('score_criterion');
  if (knownFail.length + knownPass.length < MIN_SAMPLES) return lengthSkipped('too_few_samples');

  const threshold = options.threshold ?? 0.5;
  const lengths: number[] = [];
  const probs: number[] = [];
  let inconclusive = 0;

  const judgeState = async (
    evalCase: Case,
    state: string,
    track: boolean,
  ): Promise<Judged | undefined> => {
    // No cache: padded and truncated variants must reach the judge.
    const [verdict] = await judgeCase({
      judge,
      case: { ...evalCase, input: { ...evalCase.input, state } },
      criteria: [criterion],
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const judged =
      verdict?.status === 'ok' ? grade(criterion, verdict.answer, threshold) : undefined;
    if (judged === undefined) inconclusive += 1;
    else if (track) {
      lengths.push(state.length);
      probs.push(judged.p);
    }
    return judged;
  };

  let paddingFlips = 0;
  for (const evalCase of knownFail) {
    const base = await judgeState(evalCase, evalCase.input.state, true);
    for (const padding of options.paddings) {
      const padded = await judgeState(evalCase, evalCase.input.state + padding.text, true);
      if (base !== undefined && !base.pass && padded?.pass === true) paddingFlips += 1;
    }
  }

  let truncationFlips = 0;
  let truncationSkipped = 0;
  for (const evalCase of knownPass) {
    const base = await judgeState(evalCase, evalCase.input.state, true);
    const cut = removeRedundancy(evalCase.input.state);
    if (cut === evalCase.input.state) {
      truncationSkipped += 1;
      continue;
    }
    const truncated = await judgeState(evalCase, cut, false);
    if (
      base?.pass === true &&
      truncated !== undefined &&
      !truncated.pass &&
      Math.abs(base.p - truncated.p) > options.tolerance + EPSILON
    ) {
      truncationFlips += 1;
    }
  }

  const rho = spearman(lengths, probs);
  options.emit?.({
    type: 'gauntlet.length_correlation',
    criterionId: criterion.id,
    rho,
    n: lengths.length,
  });
  return {
    result: paddingFlips > 0 || truncationFlips > 0 ? 'fail' : 'pass',
    paddingFlips,
    truncationFlips,
    lengthVerdictCorrelation: rho,
    truncationSkipped,
    inconclusive,
  };
}
