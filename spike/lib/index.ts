import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

/** Reads a required environment variable, throwing a clear error (never the value) if unset. */
export function loadEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. Set it in .env (see .env.example).`,
    );
  }
  return value;
}

const DEFAULT_GATEWAY_BASE = 'https://ai-gateway.vercel.sh';

/** POSTs JSON to the configured gateway base + path, authorized with AI_GATEWAY_API_KEY. */
export async function gatewayFetch<T = unknown>(
  path: string,
  body: unknown,
  opts: { timeoutMs: number },
): Promise<T> {
  const apiKey = loadEnv('AI_GATEWAY_API_KEY');
  const base = process.env.SPIKE_GATEWAY_BASE ?? DEFAULT_GATEWAY_BASE;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`gateway request to ${path} failed: ${res.status} ${res.statusText}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

/** Reads a JSONL file into an array of parsed rows. */
export async function readJsonl<T = unknown>(path: string): Promise<T[]> {
  const text = await readFile(path, 'utf8');
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line): T => JSON.parse(line));
}

/** Writes rows to a JSONL file, one JSON object per line. */
export async function writeJsonl(path: string, rows: unknown[]): Promise<void> {
  const text = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
  await writeFile(path, text, 'utf8');
}

/** Returns the hex-encoded SHA-256 digest of a UTF-8 string. */
export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Runs fn over items with at most n in flight, returning results in input order. */
export async function withConcurrency<T, R>(
  n: number,
  items: T[],
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  const pending = items.entries();

  async function worker(): Promise<void> {
    for (const [current, item] of pending) {
      results[current] = await fn(item);
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
  return results;
}
