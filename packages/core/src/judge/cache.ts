// Content-addressed verdict cache: one `<key>.json` file per judged case under a directory
// (default `.vet/cache`, from config). A reproducibility aid, not a determinism guarantee
// (root RISK, measured 2026-09-25: Jev answers drift run to run). Entries hold only the
// normalised answers, usage and model identity — never the transport's raw response body.
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CEV_ERROR_CODES,
  safeParseJson,
  VetError,
  type JsonSchema,
  type JudgeResponse,
} from '@vetkit/spec';

export type CachedJudgment = Pick<JudgeResponse, 'answers' | 'usage' | 'model'>;

export interface VerdictCache {
  get(key: string): Promise<CachedJudgment | undefined>;
  set(key: string, entry: CachedJudgment): Promise<void>;
}

export interface CacheDiagEvent {
  readonly type: 'cache_corrupt';
  readonly key: string;
  readonly file: string;
}

export interface FileCacheOptions {
  readonly onDiag?: (event: CacheDiagEvent) => void;
}

const KEY_RE = /^[0-9a-f]{64}$/;

// Shape check only: a file that parses but lacks these fields is corrupt, so a miss.
const entrySchema: JsonSchema = {
  type: 'object',
  properties: {
    answers: { type: 'object' },
    usage: { type: 'object' },
    model: {
      type: 'object',
      properties: {
        requested: { type: 'string' },
        resolved: { type: 'string' },
        transport: { type: 'string' },
        pinned: { type: 'boolean' },
      },
      required: ['requested', 'resolved', 'transport', 'pinned'],
    },
  },
  required: ['answers', 'usage', 'model'],
};

function cacheIo(message: string, cause?: unknown): VetError {
  return new VetError(CEV_ERROR_CODES.CACHE_IO, message, { cause });
}

function isErrnoCode(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === code;
}

function fileFor(dir: string, key: string): string {
  if (!KEY_RE.test(key)) throw cacheIo(`Invalid cache key: ${key}`);
  return join(dir, `${key}.json`);
}

export function createFileCache(dir: string, options: FileCacheOptions = {}): VerdictCache {
  return {
    async get(key) {
      const file = fileFor(dir, key);
      let text: string;
      try {
        text = await readFile(file, 'utf8');
      } catch (err) {
        if (isErrnoCode(err, 'ENOENT')) return undefined;
        throw cacheIo(`Cannot read cache entry ${file}`, err);
      }
      const parsed = safeParseJson<CachedJudgment>(text, entrySchema);
      if (!parsed.ok) {
        // Corrupt entry: a miss; the next set() overwrites it.
        options.onDiag?.({ type: 'cache_corrupt', key, file });
        return undefined;
      }
      return parsed.value;
    },

    async set(key, entry) {
      const file = fileFor(dir, key);
      // Atomic: write a unique temp file in the same directory, then rename over the target,
      // so concurrent runs never observe a half-written entry.
      const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
      const body: CachedJudgment = {
        answers: entry.answers,
        usage: entry.usage,
        model: entry.model,
      };
      try {
        await mkdir(dir, { recursive: true });
        await writeFile(tmp, JSON.stringify(body), 'utf8');
        await rename(tmp, file);
      } catch (err) {
        await rm(tmp, { force: true }).catch(() => undefined);
        throw cacheIo(`Cannot write cache entry ${file}`, err);
      }
    },
  };
}
