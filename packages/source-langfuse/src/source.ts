// createLangfuseSource: a SourceV1 over the Langfuse public API (bead mol-yxn.5). An async
// generator pages GET /api/public/traces (page, limit — Langfuse OpenAPI spec, verified
// 2026-09-29), then does one GET /api/public/traces/{id} per trace for its observations, mapped
// by map.ts. Credentials are read from the env var NAMES given in options — never literals — and
// sent as HTTP Basic auth (Langfuse's publicKey:secretKey convention). A 401/403 response, or a
// missing credential, fails the read at first pull with SOURCE_AUTH (never a silent empty
// iterator). A 429 is retried up to 3 times honoring Retry-After (capped at 60s); exhausting
// those retries, or any other non-OK response, throws SOURCE_UNREACHABLE.

import {
  CEV_ERROR_CODES,
  defineSource,
  VetError,
  type NormalizedTrace,
  type SourceV1,
} from '@vetkit/spec';
import { mapLangfuseTrace, type LangfuseObservation } from './map.ts';

export interface CreateLangfuseSourceOptions {
  /** Env var NAME (not the value) holding the Langfuse base URL, e.g. 'LANGFUSE_BASE_URL'. */
  readonly baseUrlEnv: string;
  /** Env var NAME holding the Langfuse public key. */
  readonly publicKeyEnv: string;
  /** Env var NAME holding the Langfuse secret key. */
  readonly secretKeyEnv: string;
  /** Traces requested per page (default 50). */
  readonly limit?: number;
  /** Injected fetch, for tests; defaults to globalThis.fetch. */
  readonly fetch?: typeof globalThis.fetch;
  /** Injected delay, for tests; defaults to a real setTimeout-based wait. */
  readonly sleep?: (ms: number) => Promise<void>;
}

interface TracesListResponse {
  readonly data: ReadonlyArray<{ readonly id: string }>;
  readonly meta: { readonly totalPages: number };
}

interface TraceDetailResponse {
  readonly id: string;
  readonly observations: readonly LangfuseObservation[];
}

const MAX_RETRIES = 3;
const MAX_RETRY_AFTER_MS = 60_000;
const DEFAULT_LIMIT = 50;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterMs(headerValue: string | null): number {
  const seconds = headerValue === null ? Number.NaN : Number(headerValue);
  const safeSeconds = Number.isFinite(seconds) && seconds > 0 ? seconds : 1;
  return Math.min(safeSeconds * 1000, MAX_RETRY_AFTER_MS);
}

export function createLangfuseSource(options: CreateLangfuseSourceOptions): SourceV1 {
  const { baseUrlEnv, publicKeyEnv, secretKeyEnv, limit = DEFAULT_LIMIT } = options;
  const doFetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? defaultSleep;

  function credentials(): { baseUrl: string; authHeader: string } {
    const baseUrl = process.env[baseUrlEnv];
    const publicKey = process.env[publicKeyEnv];
    const secretKey = process.env[secretKeyEnv];
    if (baseUrl === undefined || publicKey === undefined || secretKey === undefined) {
      const missing = [
        baseUrl === undefined ? baseUrlEnv : undefined,
        publicKey === undefined ? publicKeyEnv : undefined,
        secretKey === undefined ? secretKeyEnv : undefined,
      ].filter((name): name is string => name !== undefined);
      throw new VetError(
        CEV_ERROR_CODES.SOURCE_AUTH,
        `langfuse/api: missing env var(s) ${missing.join(', ')}`,
      );
    }
    const authHeader = `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString('base64')}`;
    return { baseUrl, authHeader };
  }

  async function requestJson(
    url: string,
    authHeader: string,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    let attempt = 0;
    for (;;) {
      const response = await doFetch(url, {
        headers: { authorization: authHeader, accept: 'application/json' },
        ...(signal === undefined ? {} : { signal }),
      });
      if (response.status === 401 || response.status === 403) {
        throw new VetError(
          CEV_ERROR_CODES.SOURCE_AUTH,
          `langfuse/api: ${String(response.status)} from ${url}`,
        );
      }
      if (response.status === 429) {
        attempt += 1;
        if (attempt > MAX_RETRIES) {
          throw new VetError(
            CEV_ERROR_CODES.SOURCE_UNREACHABLE,
            `langfuse/api: rate limited after ${String(MAX_RETRIES)} retries from ${url}`,
          );
        }
        await sleep(retryAfterMs(response.headers.get('retry-after')));
        continue;
      }
      if (!response.ok) {
        throw new VetError(
          CEV_ERROR_CODES.SOURCE_UNREACHABLE,
          `langfuse/api: ${String(response.status)} from ${url}`,
        );
      }
      return response.json();
    }
  }

  async function* doRead(opts: { signal?: AbortSignal }): AsyncGenerator<NormalizedTrace> {
    const { baseUrl, authHeader } = credentials();
    let page = 1;
    for (;;) {
      opts.signal?.throwIfAborted();
      const listUrl = `${baseUrl}/api/public/traces?page=${String(page)}&limit=${String(limit)}`;
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const list = (await requestJson(listUrl, authHeader, opts.signal)) as TracesListResponse;
      if (list.data.length === 0) return;

      for (const traceRef of list.data) {
        opts.signal?.throwIfAborted();
        const traceUrl = `${baseUrl}/api/public/traces/${traceRef.id}`;
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        const full = (await requestJson(traceUrl, authHeader, opts.signal)) as TraceDetailResponse;
        yield mapLangfuseTrace({ id: full.id }, full.observations);
      }

      if (page >= list.meta.totalPages) return;
      page += 1;
    }
  }

  return defineSource({
    specVersion: 'v1',
    id: 'langfuse/api',
    capabilities: { streaming: true, content: 'maybe' },
    doRead,
  });
}
