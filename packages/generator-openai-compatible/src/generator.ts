// OpenAI-compatible chat-completions generator: one raw-fetch adapter for any base URL that
// speaks POST /chat/completions (OpenAI, OpenRouter, Vercel AI Gateway, Ollama, vLLM, Groq,
// Mistral). No `ai`/`openai` dependency. The structured
// strategy is declared by the caller; a mismatch is GENERATOR_CAPABILITY before any I/O.
// The one internal retry on GENERATOR_BAD_OUTPUT shares
// the single whole-call deadline; core must not retry BAD_OUTPUT again.
import {
  defineGenerator,
  safeParseJson,
  validateJson,
  VetError,
  type CevErrorCode,
  type GeneratorV1,
  type JsonSchema,
  type ParseResult,
} from '@vetkit/spec';
import { redactApiKeyString, redactDeep } from './redact.ts';
import { normaliseOpenAIStrict, stripNullOptionals } from './strict.ts';

export interface OpenAICompatibleGeneratorOptions {
  /** Base URL up to (not including) `/chat/completions`, e.g. `https://api.openai.com/v1`. */
  readonly baseURL: string;
  readonly apiKey: string;
  readonly model: string;
  /** Declared structured-output strategy; `prompt` and `json_object` are text-only. */
  readonly structured: 'json_schema' | 'json_object' | 'prompt';
  readonly headers?: Readonly<Record<string, string>>;
  readonly fetch?: typeof fetch;
  /** Whole-call deadline covering the retry too. Default 60 000 ms. */
  readonly deadlineMs?: number;
  readonly temperature?: number;
  /** Env var the key came from; used only to name it in 401/402/403 errors. */
  readonly apiKeyEnv?: string;
  /**
   * Extra top-level body fields merged under the adapter's own (it cannot replace `model`
   * or `messages`). For OpenRouter pass `{ provider: { require_parameters: true } }` so the
   * schema is enforced rather than silently dropped by a provider that lacks it.
   */
  readonly extraBody?: Readonly<Record<string, unknown>>;
}

type GenerateRequest = Parameters<GeneratorV1['doGenerate']>[0];
type GenerateResult = Awaited<ReturnType<GeneratorV1['doGenerate']>>;
type Json = Record<string, unknown>;
type Usage = NonNullable<GenerateResult['usage']>;

interface Completion {
  readonly content: string;
  readonly usage?: Usage;
  readonly resolvedModelId?: string;
}

const ADAPTER_ID = 'openai-compatible/chat-completions';
const DEFAULT_DEADLINE_MS = 60_000;
// OpenAI json_schema.name constraint.
const SCHEMA_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const FENCE = /^\s*```(?:json)?[^\n]*\n([\s\S]*?)\n?```\s*$/;
const ANY_JSON: JsonSchema = {};

function isRecord(x: unknown): x is Json {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function parseRetryAfterMs(header: string | null): number | undefined {
  if (header === null) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(header);
  return Number.isNaN(dateMs) ? undefined : Math.max(0, dateMs - Date.now());
}

// Races a promise against the deadline/caller signal so a fetch or body read that ignores
// AbortSignal can't outlive the whole-call deadline (same pattern as judge-jev).
function raceAbort<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    work().then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (cause: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(cause);
      },
    );
  });
}

function stripFence(content: string): string {
  return FENCE.exec(content)?.[1] ?? content;
}

function describeIssues(error: VetError): string {
  const cause = error.cause;
  if (Array.isArray(cause)) {
    return cause
      .map((issue: unknown) => {
        if (!isRecord(issue)) return 'invalid';
        const path = typeof issue['instancePath'] === 'string' ? issue['instancePath'] : '';
        const message = typeof issue['message'] === 'string' ? issue['message'] : 'invalid';
        return `${path === '' ? '/' : path} ${message}`;
      })
      .join('; ');
  }
  return cause instanceof Error ? `${error.message}: ${cause.message}` : error.message;
}

function parseValue(content: string, schema: JsonSchema): ParseResult<unknown> {
  const raw = safeParseJson<unknown>(stripFence(content), ANY_JSON);
  if (!raw.ok) return raw;
  return validateJson<unknown>(stripNullOptionals(raw.value, schema), schema);
}

function readUsage(usage: unknown): Usage | undefined {
  if (!isRecord(usage)) return undefined;
  const input = usage['prompt_tokens'];
  const output = usage['completion_tokens'];
  return {
    ...(typeof input === 'number' ? { inputTokens: input } : {}),
    ...(typeof output === 'number' ? { outputTokens: output } : {}),
  };
}

function result(completion: Completion, value?: unknown): GenerateResult {
  return {
    ...(value !== undefined ? { value } : {}),
    text: completion.content,
    ...(completion.usage !== undefined ? { usage: completion.usage } : {}),
    ...(completion.resolvedModelId !== undefined
      ? { resolvedModelId: completion.resolvedModelId }
      : {}),
  };
}

export function createOpenAICompatibleGenerator(
  opts: OpenAICompatibleGeneratorOptions,
): GeneratorV1 {
  if (opts.apiKey === '') {
    throw new VetError('CONFIG_INVALID', 'apiKey must not be empty');
  }
  const { apiKey, model } = opts;
  const url = `${opts.baseURL.replace(/\/+$/, '')}/chat/completions`;
  const fetchImpl = opts.fetch ?? fetch;
  const deadlineMs = opts.deadlineMs ?? DEFAULT_DEADLINE_MS;

  const fail = (
    code: CevErrorCode,
    message: string,
    cause?: unknown,
    details?: VetError['details'],
  ): VetError =>
    new VetError(code, redactApiKeyString(message, apiKey), {
      ...(cause !== undefined ? { cause: redactDeep(cause, apiKey) } : {}),
      ...(details !== undefined ? { details } : {}),
    });

  function httpError(response: Response, body: unknown): VetError {
    const { status } = response;
    const cause = { status, body };
    if (status === 401 || status === 402 || status === 403) {
      return fail(
        'GENERATOR_UNAVAILABLE',
        `generator rejected the credentials (HTTP ${status}); check ${opts.apiKeyEnv ?? 'the generator API key'}`,
        cause,
        { retryable: false, hint: 'auth' },
      );
    }
    if (status === 429 || status >= 500) {
      const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
      return fail('GENERATOR_UNAVAILABLE', `generator transport error (HTTP ${status})`, cause, {
        retryable: true,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      });
    }
    return fail(
      'GENERATOR_UNAVAILABLE',
      `generator rejected the request for model "${model}" (HTTP ${status})`,
      cause,
      { retryable: false, hint: 'request_rejected' },
    );
  }

  function readCompletion(body: unknown): Completion {
    const choices = isRecord(body) ? body['choices'] : undefined;
    const first: unknown = Array.isArray(choices) ? choices[0] : undefined;
    const message = isRecord(first) ? first['message'] : undefined;
    if (!isRecord(message)) {
      throw fail('GENERATOR_BAD_OUTPUT', `generator returned no choices for model "${model}"`, {
        body,
      });
    }
    const { refusal, content } = message;
    if (typeof refusal === 'string' && refusal !== '') {
      throw fail(
        'GENERATOR_BAD_OUTPUT',
        `model "${model}" refused the request`,
        { refusal },
        {
          retryable: false,
          hint: 'refusal',
        },
      );
    }
    if (typeof content !== 'string') {
      throw fail(
        'GENERATOR_BAD_OUTPUT',
        `generator returned no text content for model "${model}"`,
        {
          body,
        },
      );
    }
    const usage = isRecord(body) ? readUsage(body['usage']) : undefined;
    const served = isRecord(body) ? body['model'] : undefined;
    return {
      content,
      ...(usage !== undefined ? { usage } : {}),
      ...(typeof served === 'string' ? { resolvedModelId: served } : {}),
    };
  }

  async function post(
    body: Json,
    deadline: AbortSignal,
    signal: AbortSignal,
    callerSignal: AbortSignal | undefined,
  ): Promise<Completion> {
    let exchange: { response: Response; json: { ok: boolean; value: unknown } };
    try {
      exchange = await raceAbort(async () => {
        const response = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
            ...opts.headers,
          },
          body: JSON.stringify(body),
          signal,
        });
        const json = await response.json().then(
          (value: unknown) => ({ ok: true, value }),
          (cause: unknown) => ({ ok: false, value: cause }),
        );
        return { response, json };
      }, signal);
    } catch (cause) {
      const hint = deadline.aborted
        ? 'timeout'
        : callerSignal?.aborted === true
          ? 'aborted'
          : 'network';
      const message =
        hint === 'timeout'
          ? `generator request exceeded the ${deadlineMs} ms deadline`
          : hint === 'aborted'
            ? 'generator request was aborted by the caller'
            : 'generator request failed on the network';
      throw fail('GENERATOR_UNAVAILABLE', message, cause, { retryable: hint !== 'aborted', hint });
    }
    const { response, json } = exchange;
    if (!response.ok) throw httpError(response, json.ok ? json.value : undefined);
    if (!json.ok) {
      throw fail(
        'GENERATOR_BAD_OUTPUT',
        `generator returned a response body that was not JSON for model "${model}"`,
        json.value,
      );
    }
    return readCompletion(json.value);
  }

  async function doGenerate(req: GenerateRequest): Promise<GenerateResult> {
    const { schema } = req;
    let responseFormat: Json | undefined =
      opts.structured === 'json_object' ? { type: 'json_object' } : undefined;
    if (schema !== undefined) {
      if (opts.structured !== 'json_schema') {
        throw new VetError(
          'GENERATOR_CAPABILITY',
          `generator is configured structured:'${opts.structured}', which cannot honour a schema request; configure structured:'json_schema'`,
        );
      }
      if (!SCHEMA_NAME.test(schema.name)) {
        throw new VetError(
          'GENERATOR_CAPABILITY',
          `schema name "${schema.name}" must match ${SCHEMA_NAME.source}`,
        );
      }
      // Compiles the caller's schema before I/O; E_SCHEMA_INVALID propagates unchanged.
      validateJson(undefined, schema.jsonSchema);
      responseFormat = {
        type: 'json_schema',
        json_schema: {
          name: schema.name,
          schema: normaliseOpenAIStrict(schema.jsonSchema),
          strict: true,
        },
      };
    }

    const deadline = AbortSignal.timeout(deadlineMs);
    const signal = req.signal !== undefined ? AbortSignal.any([deadline, req.signal]) : deadline;
    const send = (prompt: string): Promise<Completion> =>
      post(
        {
          ...opts.extraBody,
          model,
          messages: [
            ...(req.system !== undefined ? [{ role: 'system', content: req.system }] : []),
            { role: 'user', content: prompt },
          ],
          ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
          ...(responseFormat !== undefined ? { response_format: responseFormat } : {}),
        },
        deadline,
        signal,
        req.signal,
      );

    const first = await send(req.prompt);
    if (schema === undefined) return result(first);
    const firstParse = parseValue(first.content, schema.jsonSchema);
    if (firstParse.ok) return result(first, firstParse.value);

    const retry = await send(
      `${req.prompt}\n\nYour previous reply was invalid: ${describeIssues(firstParse.error)}`,
    );
    const retryParse = parseValue(retry.content, schema.jsonSchema);
    if (retryParse.ok) return result(retry, retryParse.value);
    throw fail(
      'GENERATOR_BAD_OUTPUT',
      `model "${model}" output failed schema "${schema.name}" after one retry: ${describeIssues(retryParse.error)}`,
      retryParse.error,
    );
  }

  return defineGenerator({
    specVersion: 'v1',
    id: ADAPTER_ID,
    capabilities: { structured: opts.structured, streaming: false },
    doGenerate,
  });
}
