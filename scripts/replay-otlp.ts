// Test tool (not product code): replays one OTLP/JSON ExportTraceServiceRequest fixture N times
// into a running OTLP/HTTP receiver, each copy carrying a distinct trace id.
// Usage: bun run scripts/replay-otlp.ts <fixture.json> --count 100 --port 4318
//          [--inject-failure 1] [--sample-rate 0.1] [--seed replay] [--concurrency 8]
// Trace ids are deterministic: sha256(`<seed>-<i>`) first 16 bytes as hex, so reruns are stable
// and `--seed` picks a different population. `--inject-failure K` rewrites the assistant output
// of the first K traces whose hashToUnit(traceId) < --sample-rate (default 0.1, the watch rate
// under test) so the injected failure is inside the judged sample. Prints one JSON summary.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const BAD_ANSWER = 'You are an idiot. Figure it out yourself, I am not going to help you.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** First 8 bytes of sha256(traceId) as a big-endian uint64, divided by 2^64. */
export function hashToUnit(traceId: string): number {
  const digest = createHash('sha256').update(traceId).digest();
  return Number(digest.readBigUInt64BE(0)) / 2 ** 64;
}

export function traceIdFor(seed: string, index: number): string {
  return createHash('sha256')
    .update(`${seed}-${String(index)}`)
    .digest('hex')
    .slice(0, 32);
}

function spanIdFor(traceId: string, original: string): string {
  return createHash('sha256').update(`${traceId}-${original}`).digest('hex').slice(0, 16);
}

function poison(attributes: unknown): void {
  if (!Array.isArray(attributes)) return;
  for (const attr of attributes as unknown[]) {
    if (!isRecord(attr) || attr['key'] !== 'gen_ai.output.messages') continue;
    if (!isRecord(attr['value']) || typeof attr['value']['stringValue'] !== 'string') continue;
    attr['value']['stringValue'] = JSON.stringify([
      { role: 'assistant', parts: [{ type: 'text', content: BAD_ANSWER }] },
    ]);
  }
}

function rewriteSpan(span: unknown, traceId: string, bad: boolean, ids: Map<string, string>): void {
  if (!isRecord(span)) return;
  span['traceId'] = traceId;
  for (const key of ['spanId', 'parentSpanId']) {
    const original = span[key];
    if (typeof original !== 'string') continue;
    let mapped = ids.get(original);
    if (mapped === undefined) {
      mapped = spanIdFor(traceId, original);
      ids.set(original, mapped);
    }
    span[key] = mapped;
  }
  if (bad) poison(span['attributes']);
}

function items(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** One copy of the fixture with every trace/span id rewritten; `bad` replaces the assistant output. */
export function rewrite(fixture: string, traceId: string, bad: boolean): string {
  const doc: unknown = JSON.parse(fixture);
  const ids = new Map<string, string>();
  if (isRecord(doc)) {
    for (const resource of items(doc['resourceSpans'])) {
      if (!isRecord(resource)) continue;
      for (const scope of items(resource['scopeSpans'])) {
        if (!isRecord(scope)) continue;
        for (const span of items(scope['spans'])) rewriteSpan(span, traceId, bad, ids);
      }
    }
  }
  return JSON.stringify(doc);
}

export interface ReplayPlan {
  readonly traceIds: string[];
  readonly injected: string[];
}

export function plan(count: number, seed: string, inject: number, sampleRate: number): ReplayPlan {
  const traceIds = Array.from({ length: count }, (_unused, i) => traceIdFor(seed, i));
  const injected = traceIds.filter((id) => hashToUnit(id) < sampleRate).slice(0, inject);
  return { traceIds, injected };
}

export interface ReplayOptions {
  readonly fixture: string;
  readonly count: number;
  readonly port: number;
  readonly seed: string;
  readonly inject: number;
  readonly sampleRate: number;
  readonly concurrency: number;
}

export async function replay(options: ReplayOptions): Promise<ReplayPlan & { failures: number }> {
  const fixture = readFileSync(options.fixture, 'utf8');
  const { traceIds, injected } = plan(
    options.count,
    options.seed,
    options.inject,
    options.sampleRate,
  );
  if (injected.length < options.inject) {
    throw new Error(`only ${String(injected.length)} of ${String(options.inject)} injectable ids`);
  }
  const bad = new Set(injected);
  const url = `http://127.0.0.1:${String(options.port)}/v1/traces`;
  let next = 0;
  let failures = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next;
      next += 1;
      const id = traceIds[i];
      if (id === undefined) return;
      // oxlint-disable-next-line no-await-in-loop
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: rewrite(fixture, id, bad.has(id)),
      });
      if (!response.ok) failures += 1;
    }
  };
  await Promise.all(Array.from({ length: options.concurrency }, worker));
  return { traceIds, injected, failures };
}

function flag(args: string[], name: string, fallback: string): string {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? fallback : (args[at + 1] ?? fallback);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const fixture = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
  if (fixture === undefined) {
    process.stderr.write('usage: replay-otlp.ts <fixture.json> --count N --port P\n');
    process.exit(2);
  }
  const result = await replay({
    fixture,
    count: Number(flag(args, 'count', '100')),
    port: Number(flag(args, 'port', '4318')),
    seed: flag(args, 'seed', 'replay'),
    inject: Number(flag(args, 'inject-failure', '0')),
    sampleRate: Number(flag(args, 'sample-rate', '0.1')),
    concurrency: Number(flag(args, 'concurrency', '8')),
  });
  process.stdout.write(
    `${JSON.stringify({ sent: result.traceIds.length, failures: result.failures, injected: result.injected, traceIds: result.traceIds })}\n`,
  );
  process.exit(result.failures === 0 ? 0 : 1);
}
