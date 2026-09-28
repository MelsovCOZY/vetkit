// TypeSafe-compatible Jev transport: one `createJevJudge()` factory, five
// transports (typesafe | vercel | openrouter presets or a fully custom baseURL +
// model, all speaking the `/v1/systemone` dialect; plus the cloudflare preset, whose
// REST run endpoint and envelope live in cloudflare.ts). Plain fetch only — the
// @typesafe-ai/sdk peer stays optional and unused here (docs/contracts/j1.md
// "Ports"; root ledger DECISION: access layer).
import { VetError, type JudgeV1, type Question } from '@vetkit/spec';
import { createCloudflareTransport } from './cloudflare.ts';
import { normalise } from './normalise.ts';
import { JEV_PRESETS, type JevPresetName, type JevProviderOptions } from './presets.ts';

const SYSTEMONE_PATH = '/v1/systemone';
const DEFAULT_DEADLINE_MS = 30_000;
const MAX_STATE_TOKENS = 32_000;
const QUESTION_TYPES: ReadonlyArray<Question['type']> = ['boolean', 'choice', 'score'];

export type CreateJevJudgeOptions = (
  | {
      readonly preset: Exclude<JevPresetName, 'cloudflare'>;
      readonly baseURL?: string;
      readonly model?: string;
    }
  | { readonly preset?: undefined; readonly baseURL: string; readonly model: string }
  | { readonly preset: 'cloudflare'; readonly accountId: string; readonly apiKeyEnv?: string }
) & {
  readonly apiKey: string;
  readonly providerOptions?: JevProviderOptions;
  readonly fetch?: typeof fetch;
  readonly deadlineMs?: number;
};

interface ResolvedTransport {
  readonly url: string;
  readonly model: string;
  readonly pinned: boolean;
  readonly transport: JevPresetName | 'custom';
  buildBody(state: string, questions: Record<string, WireQuestion>): unknown;
  mapHttpStatus(status: number): VetError | undefined;
  unwrap(wireResponse: unknown): unknown;
}

function systemOneTransport(
  baseURL: string,
  model: string,
  transport: JevPresetName | 'custom',
  providerOptions: JevProviderOptions | undefined,
): ResolvedTransport {
  return {
    url: `${baseURL}${SYSTEMONE_PATH}`,
    model,
    pinned: transport === 'custom' ? false : JEV_PRESETS[transport].pinned,
    transport,
    buildBody: (state, questions): WireRequestBody => ({
      model,
      state,
      questions,
      ...(providerOptions !== undefined ? { providerOptions } : {}),
    }),
    mapHttpStatus: () => undefined,
    unwrap: (wireResponse) => wireResponse,
  };
}

function resolveTransport(opts: CreateJevJudgeOptions): ResolvedTransport {
  if (opts.preset === 'cloudflare') {
    return {
      ...createCloudflareTransport(opts),
      pinned: JEV_PRESETS.cloudflare.pinned,
      transport: 'cloudflare',
    };
  }
  if (opts.preset !== undefined) {
    const preset = JEV_PRESETS[opts.preset];
    return systemOneTransport(
      opts.baseURL ?? preset.baseURL,
      opts.model ?? preset.defaultModel,
      opts.preset,
      opts.providerOptions ?? preset.providerOptions,
    );
  }
  return systemOneTransport(opts.baseURL, opts.model, 'custom', opts.providerOptions);
}

// Wire shapes for the /typesafe/v1/systemone dialect only.
type WireQuestion =
  | { type: 'noul'; instructions: string }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] };

interface WireRequestBody {
  readonly model: string;
  readonly state: string;
  readonly questions: Record<string, WireQuestion>;
  readonly providerOptions?: JevProviderOptions;
}

function toWireQuestion(question: Question): WireQuestion {
  if (question.type === 'boolean') return { type: 'noul', instructions: question.instructions };
  return question;
}

function estimateTokens(charLength: number): number {
  return Math.ceil(charLength / 4);
}

function questionCharLength(question: Question): number {
  if (question.type === 'boolean') return question.instructions.length;
  if (question.type === 'choice') {
    return question.instructions.length + Object.values(question.criteria).join('').length;
  }
  return question.instructions.length + question.criteria.join('').length;
}

// Pre-flight limits, checked before any I/O (docs/contracts/j1.md "Edge cases";
// TypeSafe limits: 2-10 score levels, at most 255 choice options, 32k state tokens).
function validateRequest(state: string, questions: Record<string, Question>): void {
  let longestQuestionChars = 0;
  for (const question of Object.values(questions)) {
    longestQuestionChars = Math.max(longestQuestionChars, questionCharLength(question));
    if (
      question.type === 'score' &&
      (question.criteria.length < 2 || question.criteria.length > 10)
    ) {
      throw new VetError(
        'CRITERIA_INVALID',
        `score question has ${question.criteria.length} levels; TypeSafe requires 2-10`,
      );
    }
    if (question.type === 'choice' && Object.keys(question.criteria).length > 255) {
      throw new VetError(
        'CRITERIA_INVALID',
        `choice question has ${Object.keys(question.criteria).length} options; TypeSafe allows at most 255`,
      );
    }
  }

  const estimatedTokens = estimateTokens(state.length) + estimateTokens(longestQuestionChars);
  if (estimatedTokens > MAX_STATE_TOKENS) {
    throw new VetError(
      'INPUT_TOO_LARGE',
      `estimated ${estimatedTokens} tokens (state + longest question) exceeds the ${MAX_STATE_TOKENS} token limit`,
    );
  }
}

function redactApiKeyString(value: string, apiKey: string): string {
  return apiKey === '' ? value : value.split(apiKey).join('[REDACTED]');
}

// Deep-redacts the literal API key out of any diagnostic value before it is
// attached to a thrown VetError (message, details or cause chain) — the key must
// never leak, including through a server-echoed body or a network error's message
// (root ledger DECISION: Code conventions; contract R2).
function redactDeep(
  value: unknown,
  apiKey: string,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (typeof value === 'string') return redactApiKeyString(value, apiKey);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (value instanceof Error) {
    const cause = value.cause;
    return new Error(
      redactApiKeyString(value.message, apiKey),
      cause !== undefined ? { cause: redactDeep(cause, apiKey, seen) } : undefined,
    );
  }
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, apiKey, seen));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, redactDeep(item, apiKey, seen)]),
  );
}

async function readJsonBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function parseRetryAfterMs(header: string | null): number | undefined {
  if (header === null) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(header);
  if (Number.isNaN(dateMs)) return undefined;
  return Math.max(0, dateMs - Date.now());
}

function isNestedAuthenticationError(body: unknown): boolean {
  if (typeof body !== 'object' || body === null || !('detail' in body)) return false;
  const detail = body.detail;
  if (typeof detail !== 'object' || detail === null || !('error_type' in detail)) return false;
  return detail.error_type === 'authentication_error';
}

async function toJudgeError(
  response: Response,
  apiKey: string,
  requestedModel: string,
): Promise<VetError> {
  const status = response.status;
  const requestId = response.headers.get('x-typesafe-request-id');
  const body = await readJsonBody(response);
  const cause = redactDeep({ status, body }, apiKey);

  if (status === 401 || (status === 403 && isNestedAuthenticationError(body))) {
    const idSuffix = requestId !== null ? ` (request id: ${requestId})` : '';
    return new VetError('JUDGE_UNAUTHORIZED', `judge rejected the API key${idSuffix}`, {
      cause,
      ...(requestId !== null ? { details: { requestId } } : {}),
    });
  }

  if (status === 402) {
    return new VetError('JUDGE_UNAVAILABLE', 'judge account has no credit', {
      cause,
      details: { retryable: false, hint: 'no credit' },
    });
  }

  if (status === 404 || status === 422) {
    return new VetError(
      'JUDGE_BAD_RESPONSE',
      `judge rejected the request for model "${requestedModel}" (HTTP ${status})`,
      { cause },
    );
  }

  if (status === 429 || status >= 500) {
    const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
    return new VetError('JUDGE_UNAVAILABLE', `judge transport error (HTTP ${status})`, {
      cause,
      details: retryAfterMs !== undefined ? { retryable: true, retryAfterMs } : { retryable: true },
    });
  }

  return new VetError('JUDGE_BAD_RESPONSE', `unexpected judge response (HTTP ${status})`, {
    cause,
  });
}

// Races the fetch call against the deadline/caller signal so a fetch stub (or a real
// implementation that ignores AbortSignal) can't hang the whole-call deadline; the
// real `signal` is still handed to `fetchImpl` so a real fetch aborts its own socket
// too (contract R3: AbortSignal.any, one code path, no controller+timer fallback).
function fetchWithAbort(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<Response> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    fetchImpl(url, init).then(
      (response) => {
        signal.removeEventListener('abort', onAbort);
        resolve(response);
      },
      (cause: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(cause);
      },
    );
  });
}

export function createJevJudge(opts: CreateJevJudgeOptions): JudgeV1 {
  if (opts.apiKey === '') {
    throw new VetError('CONFIG_INVALID', 'apiKey must not be empty');
  }

  const resolved = resolveTransport(opts);
  const { url, model, pinned, transport } = resolved;
  const apiKey = opts.apiKey;
  const fetchImpl = opts.fetch ?? fetch;
  const deadlineMs = opts.deadlineMs ?? DEFAULT_DEADLINE_MS;

  return {
    specVersion: 'v1',
    id: `jev-${transport}`,
    capabilities: {
      questionTypes: [...QUESTION_TYPES],
      maxStateTokens: MAX_STATE_TOKENS,
      pinned,
      transport,
      model,
    },
    async doJudge(req) {
      validateRequest(req.state, req.questions);

      const wireQuestions: Record<string, WireQuestion> = {};
      for (const [key, question] of Object.entries(req.questions)) {
        wireQuestions[key] = toWireQuestion(question);
      }

      const body = resolved.buildBody(req.state, wireQuestions);

      const deadlineSignal = AbortSignal.timeout(deadlineMs);
      const signal =
        req.signal !== undefined ? AbortSignal.any([deadlineSignal, req.signal]) : deadlineSignal;

      let response: Response;
      try {
        response = await fetchWithAbort(
          fetchImpl,
          url,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
            body: JSON.stringify(body),
            signal,
          },
          signal,
        );
      } catch (cause) {
        throw new VetError('JUDGE_TIMEOUT', 'judge request timed out or the network failed', {
          cause: redactDeep(cause, apiKey),
        });
      }

      if (!response.ok) {
        throw (
          resolved.mapHttpStatus(response.status) ?? (await toJudgeError(response, apiKey, model))
        );
      }

      let wireResponse: unknown;
      try {
        wireResponse = await response.json();
      } catch (cause) {
        throw new VetError(
          'JUDGE_BAD_RESPONSE',
          'judge returned a response that was not valid JSON',
          {
            cause: redactDeep(cause, apiKey),
          },
        );
      }

      return normalise(
        resolved.unwrap(wireResponse),
        { model, questions: req.questions },
        transport,
      );
    },
  };
}
