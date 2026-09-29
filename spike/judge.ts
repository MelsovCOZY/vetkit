import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, readJsonl, sha256, withConcurrency, writeJsonl } from './lib/index.ts';
import type { Trace } from './corpus.ts';
import type { Criterion } from './propose.ts';

export const MODEL = 'typesafe-ai/jev';
export const REPEATS = 3;
export const CONCURRENCY = 2;
export const TIMEOUT_MS = 30_000;
export const MAX_RETRY_AFTER_MS = 60_000;
const SYSTEMONE_PATH = '/typesafe/v1/systemone';
const DEFAULT_GATEWAY_BASE = 'https://ai-gateway.vercel.sh';

export type ChoiceQuestion = {
  type: 'choice';
  instructions: string;
  criteria: { yes: string; no: string; escape: string };
};

export type VerdictRow = {
  traceId: string;
  criterionId: string;
  repeat: number;
  noul: boolean | null;
  model: string | null;
  provider: string | null;
  status: 'ok' | 'unscored';
  cause?: string;
};

export type SystemOneAnswer = { type?: string; choice?: string };

export type SystemOneResponse = {
  model?: string;
  answers?: Record<string, SystemOneAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
  provider_metadata?: {
    gateway?: {
      routing?: { finalProvider?: string };
      marketCost?: string;
    };
  };
};

/**
 * Builds the judge request `state`: the question, retrieved contexts and the answer under test.
 * Never includes the reference answer or baseline scores — they would leak into faithfulness.
 */
export function buildState(trace: Trace): string {
  const docs = trace.contexts.map((c, i) => `[${i + 1}] (${c.docId})\n${c.text}`).join('\n\n');
  return `Question:\n${trace.question}\n\nRetrieved documents:\n${docs}\n\nAnswer:\n${trace.answer}`;
}

/**
 * Builds the questions map for all criteria as 3-way choices (yes / no / the criterion's escape
 * label), substituting the golden reference answer into c1's instructions only.
 */
export function buildQuestions(
  criteria: Criterion[],
  trace: Trace,
): Record<string, ChoiceQuestion> {
  const questions: Record<string, ChoiceQuestion> = {};
  for (const c of criteria) {
    const instructions =
      c.id === 'c1'
        ? c.instructions.replace('{{reference}}', trace.reference ?? 'not available')
        : c.instructions;
    questions[c.id] = {
      type: 'choice',
      instructions,
      criteria: {
        yes: 'The instructions describe this case.',
        no: 'The instructions do not describe this case.',
        escape: c.escape,
      },
    };
  }
  return questions;
}

/** Content-addressed cache key: sha256(state + JSON(questions) + repeat + model). */
export function cacheKey(state: string, questions: unknown, repeat: number, model: string): string {
  return sha256(state + JSON.stringify(questions) + String(repeat) + model);
}

/** Reads model / finalProvider / usage / marketCost out of a systemone response. */
export function extractMeta(response: SystemOneResponse): {
  model: string | null;
  finalProvider: string | null;
  inputTokens: number;
  outputTokens: number;
  marketCost: number;
} {
  return {
    model: response.model ?? null,
    finalProvider: response.provider_metadata?.gateway?.routing?.finalProvider ?? null,
    inputTokens: response.usage?.input_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
    marketCost: Number(response.provider_metadata?.gateway?.marketCost ?? 0),
  };
}

export type CallResult = { ok: true; response: SystemOneResponse } | { ok: false; cause: string };

type CallOpts = { sleep?: (ms: number) => Promise<void> };

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * POSTs one systemone request with a 30s AbortSignal.timeout. Retries exactly once, after
 * Retry-After (capped at 60s), on 429 or 5xx. Never throws — failures are returned as a
 * `{ ok: false, cause }` result.
 */
export async function callSystemOne(
  base: string,
  apiKey: string,
  body: unknown,
  opts: CallOpts = {},
): Promise<CallResult> {
  const sleep = opts.sleep ?? defaultSleep;

  async function attempt(): Promise<{ res: Response } | { errCause: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${base}${SYSTEMONE_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      return { res };
    } catch (err) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      return {
        errCause: isAbort
          ? 'timeout'
          : `network error: ${err instanceof Error ? err.message : String(err)}`,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  let result = await attempt();
  if (
    'res' in result &&
    !result.res.ok &&
    (result.res.status === 429 || result.res.status >= 500)
  ) {
    const retryAfterHeader = result.res.headers.get('retry-after');
    const retryAfterSec = retryAfterHeader ? Number(retryAfterHeader) : 1;
    const waitMs = Math.min(
      MAX_RETRY_AFTER_MS,
      Math.max(0, Number.isFinite(retryAfterSec) ? retryAfterSec : 1) * 1000,
    );
    await sleep(waitMs);
    result = await attempt();
  }

  if ('errCause' in result) return { ok: false, cause: result.errCause };
  if (!result.res.ok) return { ok: false, cause: `http ${result.res.status}` };
  const response: SystemOneResponse = await result.res.json();
  return { ok: true, response };
}

export type JudgeOutcome = {
  rows: VerdictRow[];
  inputTokens: number;
  outputTokens: number;
  marketCost: number;
  networkCall: boolean;
};

/** Judges one trace for one repeat, all criteria in a single request, serving from the disk cache when possible. */
export async function judgeOne(
  trace: Trace,
  repeat: number,
  criteria: Criterion[],
  cacheDir: string,
  opts: { base: string; apiKey: string; sleep?: (ms: number) => Promise<void> },
): Promise<JudgeOutcome> {
  const state = buildState(trace);
  const questions = buildQuestions(criteria, trace);
  const key = cacheKey(state, questions, repeat, MODEL);
  const cachePath = join(cacheDir, `${key}.json`);

  let response: SystemOneResponse | undefined;
  let cause: string | undefined;
  let networkCall = false;

  if (existsSync(cachePath)) {
    const cached: SystemOneResponse = JSON.parse(await readFile(cachePath, 'utf8'));
    response = cached;
  } else {
    networkCall = true;
    const body = {
      model: MODEL,
      state,
      questions,
      providerOptions: { gateway: { only: ['typesafe-ai'], zeroDataRetention: true } },
    };
    const result = await callSystemOne(
      opts.base,
      opts.apiKey,
      body,
      opts.sleep ? { sleep: opts.sleep } : {},
    );
    if (result.ok) {
      response = result.response;
      await mkdir(cacheDir, { recursive: true });
      await writeFile(cachePath, JSON.stringify(response), 'utf8');
    } else {
      cause = result.cause;
    }
  }

  const meta = response ? extractMeta(response) : null;
  const model = meta?.model ?? null;
  const provider = meta?.finalProvider ?? null;

  const rows: VerdictRow[] = criteria.map((c) => {
    if (!response) {
      return {
        traceId: trace.traceId,
        criterionId: c.id,
        repeat,
        noul: null,
        model,
        provider,
        status: 'unscored',
        cause: cause ?? 'unknown error',
      };
    }
    const answer = response.answers?.[c.id];
    if (!answer || typeof answer.choice !== 'string') {
      return {
        traceId: trace.traceId,
        criterionId: c.id,
        repeat,
        noul: null,
        model,
        provider,
        status: 'unscored',
        cause: 'missing answer',
      };
    }
    const noul = answer.choice === 'yes' ? true : answer.choice === 'no' ? false : null;
    return {
      traceId: trace.traceId,
      criterionId: c.id,
      repeat,
      noul,
      model,
      provider,
      status: 'ok',
    };
  });

  return {
    rows,
    inputTokens: meta?.inputTokens ?? 0,
    outputTokens: meta?.outputTokens ?? 0,
    marketCost: meta?.marketCost ?? 0,
    networkCall,
  };
}

export type JudgeSummary = {
  rows: VerdictRow[];
  cacheHits: number;
  networkCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalMarketCost: number;
  models: string[];
  finalProviders: string[];
};

/** Judges every trace x repeat, all criteria per call, with bounded concurrency and a disk cache. */
export async function runJudge(
  traces: Trace[],
  criteria: Criterion[],
  cacheDir: string,
  opts: {
    base: string;
    apiKey: string;
    sleep?: (ms: number) => Promise<void>;
    concurrency?: number;
    repeats?: number;
  },
): Promise<JudgeSummary> {
  const repeats = opts.repeats ?? REPEATS;
  const jobs =
    repeats > 0
      ? traces.flatMap((trace) =>
          Array.from({ length: repeats }, (_, repeat) => ({ trace, repeat })),
        )
      : [];

  const total = jobs.length;
  const startedAt = Date.now();
  let completed = 0;

  const outcomes = await withConcurrency(opts.concurrency ?? CONCURRENCY, jobs, async (job) => {
    const outcome = await judgeOne(job.trace, job.repeat, criteria, cacheDir, opts);
    completed += 1;
    if (completed % 50 === 0 || completed === total) {
      const elapsedS = Math.round((Date.now() - startedAt) / 1000);
      console.log(`${completed}/${total} calls (${elapsedS}s elapsed)`);
    }
    return outcome;
  });

  const summary: JudgeSummary = {
    rows: [],
    cacheHits: 0,
    networkCalls: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalMarketCost: 0,
    models: [],
    finalProviders: [],
  };
  const modelSet = new Set<string>();
  const providerSet = new Set<string>();

  for (const outcome of outcomes) {
    summary.rows.push(...outcome.rows);
    summary.totalInputTokens += outcome.inputTokens;
    summary.totalOutputTokens += outcome.outputTokens;
    summary.totalMarketCost += outcome.marketCost;
    if (outcome.networkCall) summary.networkCalls += 1;
    else summary.cacheHits += 1;
    for (const row of outcome.rows) {
      if (row.model) modelSet.add(row.model);
      if (row.provider) providerSet.add(row.provider);
    }
  }
  summary.models = [...modelSet];
  summary.finalProviders = [...providerSet];

  console.log(`cache hits: ${summary.cacheHits}, network: ${summary.networkCalls}`);
  const ok = summary.rows.filter((r) => r.status === 'ok').length;
  const unscored = summary.rows.length - ok;
  console.log(`rows: ${summary.rows.length} ok=${ok} unscored=${unscored}`);
  console.log(
    `usage: input_tokens=${summary.totalInputTokens} output_tokens=${summary.totalOutputTokens} marketCost=${summary.totalMarketCost}`,
  );
  console.log(
    `model(s): ${summary.models.join(', ')}; finalProvider(s): ${summary.finalProviders.join(', ')}`,
  );

  return summary;
}

async function main(): Promise<void> {
  const spikeDataDir = fileURLToPath(new URL('./data/', import.meta.url));
  const apiKey = loadEnv('AI_GATEWAY_API_KEY'); // reads process.env.AI_GATEWAY_API_KEY, never logs it
  const base = process.env.SPIKE_GATEWAY_BASE ?? DEFAULT_GATEWAY_BASE;

  const traces = await readJsonl<Trace>(join(spikeDataDir, 'traces.jsonl'));
  const criteria: Criterion[] = JSON.parse(
    await readFile(join(spikeDataDir, 'criteria.json'), 'utf8'),
  );
  const cacheDir = join(spikeDataDir, 'cache');

  const summary = await runJudge(traces, criteria, cacheDir, {
    base,
    apiKey,
    concurrency: CONCURRENCY,
  });

  await writeJsonl(join(spikeDataDir, 'verdicts.jsonl'), summary.rows);
  console.log(`judge.ts: wrote ${summary.rows.length} rows to spike/data/verdicts.jsonl`);
}

if (import.meta.main) {
  await main();
}
