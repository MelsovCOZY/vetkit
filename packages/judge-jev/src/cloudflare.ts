// Cloudflare Workers AI transport for Jev: the REST run endpoint
// (POST /accounts/<id>/ai/run/typesafe/jev, body {state, questions}) wrapped in
// Cloudflare's {result, success, errors} envelope. A sibling transport behind the
// same JudgeV1, not a separate contract (root ledger DECISION: access layer).
// transport.ts owns the shared parts (question mapping, deadline, error mapping,
// redaction, normalise()); this file only supplies what differs. pinned:false comes
// from JEV_PRESETS.cloudflare (DECISION pinning honesty).
//
// UNVERIFIED (bead RISK): the envelope shape follows Cloudflare's docs
// (https://developers.cloudflare.com/ai/models/typesafe/jev/) and has not been
// exercised with a real token yet.
import { VetError } from '@vetkit/spec';
import { JEV_PRESETS } from './presets.ts';

const DEFAULT_API_KEY_ENV = 'CLOUDFLARE_API_TOKEN';

export interface CloudflareTransportOptions {
  readonly accountId: string;
  // Name (never the value) of the env var holding the token, used in 403 messages.
  readonly apiKeyEnv?: string;
}

export interface CloudflareTransport {
  readonly url: string;
  readonly model: string;
  buildBody(state: string, questions: Record<string, unknown>): Record<string, unknown>;
  // Cloudflare-specific HTTP status mapping; undefined falls back to the shared mapper.
  mapHttpStatus(status: number): VetError | undefined;
  // Unwraps the {result, success, errors} envelope into the raw Jev response.
  unwrap(envelope: unknown): unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessages(errors: unknown): string {
  if (!Array.isArray(errors)) return 'no errors reported';
  const messages = errors.map((e) =>
    isRecord(e) && typeof e['message'] === 'string' ? e['message'] : 'unknown error',
  );
  return messages.length > 0 ? messages.join('; ') : 'no errors reported';
}

export function createCloudflareTransport(opts: CloudflareTransportOptions): CloudflareTransport {
  if (typeof opts.accountId !== 'string' || opts.accountId.trim() === '') {
    throw new VetError('CONFIG_INVALID', 'the cloudflare preset requires a non-empty accountId');
  }
  const preset = JEV_PRESETS.cloudflare;
  const apiKeyEnv = opts.apiKeyEnv ?? DEFAULT_API_KEY_ENV;
  const accountId = encodeURIComponent(opts.accountId);

  return {
    url: `${preset.baseURL}/accounts/${accountId}/ai/run/${preset.defaultModel}`,
    model: preset.defaultModel,
    buildBody: (state, questions) => ({ state, questions }),
    mapHttpStatus(status) {
      if (status !== 403) return undefined;
      return new VetError(
        'JUDGE_UNAVAILABLE',
        `Cloudflare refused the token (HTTP 403); check that ${apiKeyEnv} has Workers AI access`,
        { details: { retryable: false } },
      );
    },
    unwrap(envelope) {
      if (!isRecord(envelope) || envelope['success'] !== true) {
        const errors = isRecord(envelope) ? envelope['errors'] : undefined;
        throw new VetError(
          'JUDGE_BAD_RESPONSE',
          `Cloudflare reported failure: ${errorMessages(errors)}`,
        );
      }
      const result = envelope['result'];
      if (!isRecord(result) || Object.keys(result).length === 0) {
        throw new VetError(
          'JUDGE_BAD_RESPONSE',
          'Cloudflare returned success with an empty result',
        );
      }
      return result;
    },
  };
}
