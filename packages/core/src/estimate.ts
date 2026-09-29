// `vet estimate` numbers: judge calls, input tokens, cost and minutes
// before a run or a validate, with no network call. Prices are input data (the CLI passes the
// transport's price row from its adapter); core holds no vendor price. The only I/O is a
// listing of the verdict cache directory, so cached cases count as 0 calls.
import { readdir } from 'node:fs/promises';
import type { Case, Criterion, RequestFormat } from '@vetkit/spec';
import { buildRequest, cacheKey } from './judge/request.ts';
import { CALIBRATION_MIN_REPEATS } from './validate/calibrate.ts';
import { POSITION_SWAP_MAX_ORDERS } from './validate/gauntlet-bias.ts';

/** The measured gateway pace: about 25 judge calls per minute. */
export const DEFAULT_CALLS_PER_MINUTE = 25;

const CHARS_PER_TOKEN = 4;
const PER_MTOK = 1_000_000;

/** USD per 1M tokens for one transport, with where the number came from. */
export interface EstimatePricing {
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
  readonly source: string;
  readonly asOf: string;
}

export type CostEstimate =
  | { readonly usd: number; readonly source: string; readonly asOf: string }
  | 'unknown';

export interface EstimateRunInput {
  readonly criteria: readonly Criterion[];
  readonly cases: readonly Case[];
  /** The judge's declared model id (JudgeV1.capabilities.model), part of the cache key. */
  readonly model: string;
  readonly cacheDir?: string;
  /** Absent for a transport without a known price: cost is 'unknown'. */
  readonly pricing?: EstimatePricing;
  readonly callsPerMinute?: number;
  /** The judge's request format (capabilities.requestFormat); state size is measured after rendering. */
  readonly requestFormat?: RequestFormat;
}

export interface RunEstimate {
  readonly for: 'run';
  readonly cases: number;
  readonly criteria: number;
  readonly cacheHits: number;
  readonly calls: number;
  readonly inputTokens: number;
  readonly cost: CostEstimate;
  readonly minutes: number;
  readonly callsPerMinute: number;
  readonly warnings: string[];
}

export type Unknowable = number | 'unknown';

export interface EstimatePart {
  readonly name: 'calibration' | 'gauntlet-position-swap' | 'gauntlet-bias' | 'gauntlet-controls';
  readonly calls: Unknowable;
  readonly inputTokens: Unknowable;
  readonly cost: CostEstimate;
  readonly minutes: Unknowable;
  /** Why the numbers are 'unknown'. */
  readonly reason?: string;
}

export interface EstimateValidateInput extends EstimateRunInput {
  /** Judge repeats per labelled case (calibration); defaults to CALIBRATION_MIN_REPEATS. */
  readonly repeats?: number;
  /** Variants per case in each gauntlet pack; an absent size → that part is 'unknown'. */
  readonly gauntletPackSizes?: { readonly bias?: number; readonly controls?: number };
}

export interface ValidateEstimate {
  readonly for: 'validate';
  readonly base: RunEstimate;
  readonly parts: EstimatePart[];
  readonly total: Omit<EstimatePart, 'name'>;
  readonly warnings: string[];
}

function priced(inputTokens: number, pricing: EstimatePricing | undefined): CostEstimate {
  // Output tokens are not estimated, so a transport that bills output has no honest total.
  if (pricing === undefined || pricing.outputPerMTok !== 0) return 'unknown';
  return {
    usd: (inputTokens * pricing.inputPerMTok) / PER_MTOK,
    source: pricing.source,
    asOf: pricing.asOf,
  };
}

function caseTokens(
  evalCase: Case,
  criteria: readonly Criterion[],
  requestFormat?: RequestFormat,
): number {
  const req = buildRequest(evalCase, criteria, { requestFormat });
  return Math.ceil((req.state.length + JSON.stringify(req.questions).length) / CHARS_PER_TOKEN);
}

async function cachedFiles(cacheDir: string, warnings: string[]): Promise<Set<string>> {
  try {
    return new Set(await readdir(cacheDir));
  } catch (err) {
    const code = typeof err === 'object' && err !== null && 'code' in err ? err.code : undefined;
    if (code !== 'ENOENT') {
      warnings.push(`cache dir ${cacheDir} is unreadable (${String(code)}); counting no hits`);
    }
    return new Set();
  }
}

export async function estimateRun(input: EstimateRunInput): Promise<RunEstimate> {
  const { criteria, cases, model, pricing } = input;
  const callsPerMinute = input.callsPerMinute ?? DEFAULT_CALLS_PER_MINUTE;
  const warnings: string[] = [];
  const cached =
    input.cacheDir === undefined ? new Set<string>() : await cachedFiles(input.cacheDir, warnings);
  let cacheHits = 0;
  let inputTokens = 0;
  for (const evalCase of cases) {
    if (
      cached.has(
        `${cacheKey(evalCase, criteria, model, { requestFormat: input.requestFormat })}.json`,
      )
    )
      cacheHits += 1;
    else inputTokens += caseTokens(evalCase, criteria, input.requestFormat);
  }
  const calls = cases.length - cacheHits;
  return {
    for: 'run',
    cases: cases.length,
    criteria: criteria.length,
    cacheHits,
    calls,
    inputTokens,
    cost: priced(inputTokens, pricing),
    minutes: calls / callsPerMinute,
    callsPerMinute,
    warnings,
  };
}

function scaled(
  name: EstimatePart['name'],
  base: RunEstimate,
  factor: number | undefined,
  pricing: EstimatePricing | undefined,
): EstimatePart {
  if (factor === undefined) {
    return {
      name,
      calls: 'unknown',
      inputTokens: 'unknown',
      cost: 'unknown',
      minutes: 'unknown',
      reason: `${name} needs its pack size, which the config does not carry`,
    };
  }
  const inputTokens = base.inputTokens * factor;
  return {
    name,
    calls: base.calls * factor,
    inputTokens,
    cost: priced(inputTokens, pricing),
    minutes: base.minutes * factor,
  };
}

// Options as the position-swap gauntlet sends them: boolean is yes/no/escape; a choice is its
// keys plus an escape key unless one of the keys already is the escape. Score has no swap.
function optionCount(criterion: Criterion): number {
  if (criterion.type === 'boolean') return 3;
  if (criterion.type !== 'choice') return 0;
  const keys = Object.keys(criterion.criteria);
  return keys.includes(String(criterion.escape)) ? keys.length : keys.length + 1;
}

function factorial(n: number): number {
  return n <= 1 ? 1 : n * factorial(n - 1);
}

// The gauntlet bypasses the verdict cache, so every case counts. One call judges one
// criterion in one option order, so tokens are the single-criterion request size per order.
function positionSwapPart(input: EstimateValidateInput, callsPerMinute: number): EstimatePart {
  let calls = 0;
  let inputTokens = 0;
  for (const criterion of input.criteria) {
    const n = optionCount(criterion);
    if (n === 0) continue;
    const orders = Math.min(factorial(n), POSITION_SWAP_MAX_ORDERS);
    for (const evalCase of input.cases) {
      calls += orders;
      inputTokens += orders * caseTokens(evalCase, [criterion], input.requestFormat);
    }
  }
  return {
    name: 'gauntlet-position-swap',
    calls,
    inputTokens,
    cost: priced(inputTokens, input.pricing),
    minutes: calls / callsPerMinute,
  };
}

export async function estimateValidate(input: EstimateValidateInput): Promise<ValidateEstimate> {
  const base = await estimateRun(input);
  const packs = input.gauntletPackSizes ?? {};
  const repeats = input.repeats ?? CALIBRATION_MIN_REPEATS;
  const swap = positionSwapPart(input, base.callsPerMinute);
  const parts = [
    scaled('calibration', base, repeats, input.pricing),
    swap,
    scaled('gauntlet-bias', base, packs.bias, input.pricing),
    scaled('gauntlet-controls', base, packs.controls, input.pricing),
  ];
  const known = parts.every((p) => p.calls !== 'unknown');
  const factor = known ? repeats + (packs.bias ?? 0) + (packs.controls ?? 0) : undefined;
  const {
    name: _name,
    reason: _reason,
    ...scaledTotal
  } = scaled('calibration', base, factor, input.pricing);
  const total =
    scaledTotal.calls === 'unknown'
      ? scaledTotal
      : (() => {
          const calls = scaledTotal.calls + Number(swap.calls);
          const inputTokens = Number(scaledTotal.inputTokens) + Number(swap.inputTokens);
          return {
            calls,
            inputTokens,
            cost: priced(inputTokens, input.pricing),
            minutes: calls / base.callsPerMinute,
          };
        })();
  return { for: 'validate', base, parts, total, warnings: base.warnings };
}
