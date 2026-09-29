// Response normaliser: turns a raw /v1/systemone-dialect Jev wire response (already
// parsed from JSON by the caller — transport.ts's `await response.json()`, or
// the Cloudflare envelope unwrap) into the IR `JudgeResponse`, so
// `packages/core` never sees a raw wire shape (docs/contracts/j1.md "Ports"; root
// ledger DECISION: access layer). One normaliser feeds every transport.
//
// Scope (bead payload "Scope"): normalisation, confidence lift, legend fill,
// provider selection, pinned flag, usage snake->camel, raw passthrough. Fetching is
// transport.ts's job; Cloudflare envelope unwrapping is a separate concern.
import {
  validateJson,
  VetError,
  type Answer,
  type JsonSchema,
  type JudgeResponse,
  type Question,
} from '@vetkit/spec';
import { JEV_PRESETS, type JevPresetName } from './presets.ts';

export interface NormaliseRequested {
  readonly model: string;
  readonly questions: Record<string, Question>;
}

// Loose on purpose: only the shape normalise() itself cannot safely destructure
// without a runtime check is enforced here (answers must be an object of objects,
// each with a "type"). Per-answer required fields (probabilities, score, choice,
// legend) are checked by hand below, where the specific missing field can be named
// in the JUDGE_BAD_RESPONSE message.
const WIRE_RESPONSE_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    model: { type: 'string' },
    answers: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        properties: { type: { enum: ['noul', 'choice', 'score'] } },
        required: ['type'],
      },
    },
    usage: {
      type: 'object',
      properties: {
        input_tokens: { type: 'number' },
        output_tokens: { type: 'number' },
      },
    },
    provider_metadata: { type: 'object' },
  },
  required: ['answers'],
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? // Guarded by the typeof/null check above (trusted-boundary cast, same
      // pattern as packages/spec/src/json.ts).
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      (value as Record<string, unknown>)
    : undefined;
}

function badResponse(message: string): VetError {
  return new VetError('JUDGE_BAD_RESPONSE', message);
}

function extractTypesafeConfidence(
  body: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const providerMetadata = asRecord(body['provider_metadata']);
  const typesafe =
    providerMetadata !== undefined ? asRecord(providerMetadata['typesafe']) : undefined;
  return typesafe !== undefined ? asRecord(typesafe['confidence']) : undefined;
}

function extractGatewayRouting(body: Record<string, unknown>): Record<string, unknown> | undefined {
  const providerMetadata = asRecord(body['provider_metadata']);
  const gateway =
    providerMetadata !== undefined ? asRecord(providerMetadata['gateway']) : undefined;
  return gateway !== undefined ? asRecord(gateway['routing']) : undefined;
}

// Finds the credentialType of the provider attempt that actually succeeded
// (routing.modelAttempts[].providerAttempts[].success === true), rather than
// assuming the first attempt succeeded (root ledger PREMISE: the gateway can plan
// more than one provider and fall back).
function extractCredentialType(routing: Record<string, unknown> | undefined): string | undefined {
  const modelAttempts = routing?.['modelAttempts'];
  if (!Array.isArray(modelAttempts)) return undefined;
  for (const modelAttempt of modelAttempts) {
    const providerAttempts = asRecord(modelAttempt)?.['providerAttempts'];
    if (!Array.isArray(providerAttempts)) continue;
    for (const attempt of providerAttempts) {
      const attemptRecord = asRecord(attempt);
      if (
        attemptRecord?.['success'] === true &&
        typeof attemptRecord['credentialType'] === 'string'
      ) {
        return attemptRecord['credentialType'];
      }
    }
  }
  return undefined;
}

function liftConfidence(
  key: string,
  inline: number | undefined,
  typesafeConfidence: Record<string, unknown> | undefined,
): number | undefined {
  if (inline !== undefined) return inline;
  const lifted = typesafeConfidence?.[key];
  return typeof lifted === 'number' ? lifted : undefined;
}

function toNumericProbabilities(key: string, rawProbabilities: unknown): Record<string, number> {
  const record = asRecord(rawProbabilities);
  if (record === undefined) {
    throw badResponse(`answer "${key}" is missing "probabilities"`);
  }
  const probabilities: Record<string, number> = {};
  for (const [probKey, value] of Object.entries(record)) {
    if (typeof value !== 'number') {
      throw badResponse(`answer "${key}" probability "${probKey}" is not a number`);
    }
    probabilities[probKey] = value;
  }
  return probabilities;
}

function resolveLegend(
  key: string,
  rawLegend: unknown,
  requestedQuestion: Question | undefined,
): Record<string, string> {
  const legendRecord = asRecord(rawLegend);
  if (legendRecord !== undefined) {
    const legend: Record<string, string> = {};
    for (const [legendKey, value] of Object.entries(legendRecord)) {
      if (typeof value !== 'string') {
        throw badResponse(`answer "${key}" legend value for "${legendKey}" is not a string`);
      }
      legend[legendKey] = value;
    }
    return legend;
  }
  if (requestedQuestion?.type === 'score') {
    const legend: Record<string, string> = {};
    requestedQuestion.criteria.forEach((text, index) => {
      legend[String(index)] = text;
    });
    return legend;
  }
  throw badResponse(
    `answer "${key}" (score) is missing "legend" and no requested score question to fill it from`,
  );
}

function processAnswer(
  key: string,
  rawAnswer: unknown,
  requestedQuestion: Question | undefined,
  typesafeConfidence: Record<string, unknown> | undefined,
): Answer {
  const answer = asRecord(rawAnswer);
  const type = answer?.['type'];
  if (answer === undefined || typeof type !== 'string') {
    throw badResponse(`answer "${key}" is missing a "type"`);
  }

  if (type === 'noul') {
    const noul = answer['noul'];
    if (typeof noul !== 'number') {
      throw badResponse(`answer "${key}" (noul) is missing a numeric "noul"`);
    }
    return { type: 'boolean', probability: noul };
  }

  const probabilities = toNumericProbabilities(key, answer['probabilities']);
  const inlineConfidence =
    typeof answer['confidence'] === 'number' ? answer['confidence'] : undefined;
  const confidence = liftConfidence(key, inlineConfidence, typesafeConfidence);
  if (confidence === undefined) {
    throw badResponse(
      `answer "${key}" (${type}) is missing "confidence" and has no lift available`,
    );
  }

  if (type === 'choice') {
    const choice = answer['choice'];
    if (typeof choice !== 'string') {
      throw badResponse(`answer "${key}" (choice) is missing "choice"`);
    }
    return { type: 'choice', choice, confidence, probabilities };
  }

  if (type === 'score') {
    const score = answer['score'];
    if (typeof score !== 'number') {
      throw badResponse(`answer "${key}" (score) is missing "score"`);
    }
    const legend = resolveLegend(key, answer['legend'], requestedQuestion);
    return { type: 'score', score, confidence, legend, probabilities };
  }

  throw badResponse(`answer "${key}" has unknown type "${type}"`);
}

export function normalise(
  rawResponse: unknown,
  requested: NormaliseRequested,
  preset: JevPresetName | 'custom',
): JudgeResponse {
  const validated = validateJson<Record<string, unknown>>(rawResponse, WIRE_RESPONSE_SCHEMA);
  if (!validated.ok) {
    throw new VetError('JUDGE_BAD_RESPONSE', 'judge response failed wire schema validation', {
      cause: validated.error,
    });
  }
  const body = validated.value;

  // Schema guarantees `answers` is an object; each value is still `unknown` (the
  // schema only checked it has a "type" property).
  const rawAnswers = asRecord(body['answers']);
  if (rawAnswers === undefined) {
    throw badResponse('judge response "answers" is not an object');
  }

  const typesafeConfidence = extractTypesafeConfidence(body);
  const answers: Record<string, Answer> = {};
  for (const [key, rawAnswer] of Object.entries(rawAnswers)) {
    answers[key] = processAnswer(key, rawAnswer, requested.questions[key], typesafeConfidence);
  }

  const rawUsage = asRecord(body['usage']);
  const inputTokens = rawUsage?.['input_tokens'];
  const outputTokens = rawUsage?.['output_tokens'];
  const usage = {
    inputTokens: typeof inputTokens === 'number' ? inputTokens : 0,
    outputTokens: typeof outputTokens === 'number' ? outputTokens : 0,
  };

  const routing = extractGatewayRouting(body);
  const finalProvider = routing?.['finalProvider'];
  const provider = typeof finalProvider === 'string' ? finalProvider : undefined;
  const credentialType = extractCredentialType(routing);

  const resolved = typeof body['model'] === 'string' ? body['model'] : requested.model;

  return {
    answers,
    usage,
    model: {
      requested: requested.model,
      resolved,
      transport: preset,
      pinned: preset === 'custom' ? false : JEV_PRESETS[preset].pinned,
      ...(provider !== undefined ? { provider } : {}),
      ...(credentialType !== undefined ? { credentialType } : {}),
    },
    raw: body,
  };
}
