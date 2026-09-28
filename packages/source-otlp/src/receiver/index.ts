// OTLP/HTTP receiver (bead mol-pij.8): a plain node:http server accepting
// `POST /v1/traces` with an OTLP/JSON ExportTraceServiceRequest body, JSON only (no
// protobuf/gRPC — docs/contracts/j5.md "Input contract"). Every request is parsed through
// readOtlpJson (the same schema chokepoint the file source uses), grouped by traceId and
// normalized (default dialect cascade unless the caller passes its own), and `onRequest` is
// called once per trace in the body — a duplicate traceId across two separate requests is
// not this module's concern (contract pij.8 revision 3: cross-request dedupe lives in the
// CLI's otlpSourceFromArg, not here). This module keeps no state across requests.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import type { NormalizedTrace } from '@vetkit/spec';
import { DEFAULT_DIALECT_ORDER } from '../default-dialects.ts';
import { groupByTraceId, normalizeTrace, type DialectV1 } from '../normalize/index.ts';
import { readOtlpJson } from '../reader/index.ts';
import { buildSpanTree } from '../reader/tree.ts';

const gunzipAsync = promisify(gunzip);

const MAX_BODY_BYTES = 16 * 1024 * 1024;

export interface StartReceiverOptions {
  readonly port: number;
  readonly host?: string;
  readonly onRequest: (trace: NormalizedTrace) => void;
  readonly dialects?: readonly DialectV1[];
}

export interface Receiver {
  readonly port: number;
  close(): Promise<void>;
}

class BodyTooLargeError extends Error {}

// A body over `limit` is still fully drained (never destroyed mid-stream) so the client's
// socket can carry the 413 response back cleanly instead of seeing an abrupt reset.
function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let tooLarge = false;
    let settled = false;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > limit) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      if (tooLarge) {
        rejectPromise(new BodyTooLargeError('request body exceeds the 16 MiB limit'));
        return;
      }
      resolvePromise(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (!settled) {
        settled = true;
        rejectPromise(err);
      }
    });
  });
}

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function isJsonContentType(header: string | undefined): boolean {
  return header !== undefined && /^application\/json(?:\s*;.*)?$/i.test(header.trim());
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  onRequest: (trace: NormalizedTrace) => void,
  dialects: readonly DialectV1[],
): Promise<void> {
  if (req.method !== 'POST' || req.url !== '/v1/traces') {
    req.resume();
    respondJson(res, 404, { error: 'not found' });
    return;
  }
  if (!isJsonContentType(req.headers['content-type'])) {
    req.resume();
    respondJson(res, 415, { error: 'json only' });
    return;
  }
  const encoding = req.headers['content-encoding'];
  if (encoding !== undefined && encoding !== 'identity' && encoding !== 'gzip') {
    req.resume();
    respondJson(res, 415, { error: 'unsupported encoding' });
    return;
  }

  let raw: Buffer;
  try {
    raw = await readBody(req, MAX_BODY_BYTES);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      respondJson(res, 413, { error: 'payload too large' });
      return;
    }
    throw err;
  }

  const text = (encoding === 'gzip' ? await gunzipAsync(raw) : raw).toString('utf8');
  const result = readOtlpJson(text);
  if ('error' in result) {
    respondJson(res, 400, { error: 'OTLP_PARSE' });
    return;
  }

  for (const group of groupByTraceId(result.resourceSpans)) {
    const tree = buildSpanTree(group.spans);
    onRequest(normalizeTrace(tree, group.resource, dialects, undefined, group.traceId));
  }
  respondJson(res, 200, { partialSuccess: {} });
}

/** Starts an OTLP/HTTP receiver; resolves once it is listening. `port: 0` binds an
 * ephemeral port (the resolved Receiver's `port` is the one actually bound). */
export function startReceiver(opts: StartReceiverOptions): Promise<Receiver> {
  const dialects = opts.dialects ?? DEFAULT_DIALECT_ORDER;
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer((req, res) => {
      handleRequest(req, res, opts.onRequest, dialects).catch(() => {
        res.destroy();
      });
    });
    server.once('error', rejectPromise);
    server.listen(opts.port, opts.host ?? '127.0.0.1', () => {
      const address = server.address();
      const boundPort = typeof address === 'object' && address !== null ? address.port : opts.port;
      resolvePromise({
        port: boundPort,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}
