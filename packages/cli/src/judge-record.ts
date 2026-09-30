// `vet run --record <dir>` / `--replay <dir>`: capture every doJudge response, then answer the
// same requests later with no network and no credential. A recording is `<dir>/manifest.json`
// plus one `<sha256 of {state, questions}>.json` per distinct request, holding exactly
// `{ answers, usage, model }` (the verdict-cache projection): never `raw`, the request or a key.
// Repeats send identical requests, so `--record` with `--repeat n` collapses to one file per
// request (the last write wins) and a replay answers every repeat the same way.
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import {
  CEV_ERROR_CODES,
  safeParseJson,
  VetError,
  type JsonSchema,
  type JudgeResponse,
  type JudgeV1,
} from '@vetkit/spec';
import { redact } from './redact.ts';

const RECORD_VERSION = 1;
const MANIFEST = 'manifest.json';
const REPLAY_MISS = 'REPLAY_MISS';

type JudgeRequest = Parameters<JudgeV1['doJudge']>[0];
type Recorded = Pick<JudgeResponse, 'answers' | 'usage' | 'model'>;

interface Manifest {
  readonly recordVersion: number;
  readonly vetkit: string;
  readonly judge: { readonly id: string; readonly capabilities: JudgeV1['capabilities'] };
}

const manifestSchema: JsonSchema = {
  type: 'object',
  properties: {
    recordVersion: { type: 'number' },
    vetkit: { type: 'string' },
    judge: {
      type: 'object',
      properties: { id: { type: 'string' }, capabilities: { type: 'object' } },
      required: ['id', 'capabilities'],
    },
  },
  required: ['recordVersion', 'vetkit', 'judge'],
};

const recordedSchema: JsonSchema = {
  type: 'object',
  properties: { answers: { type: 'object' }, usage: { type: 'object' }, model: { type: 'object' } },
  required: ['answers', 'usage', 'model'],
};

const require = createRequire(import.meta.url);

/** The CLI's own version, as `vet --version` reports it (same two lines as program.ts). */
export function readCliVersion(): string {
  const pkgJson = require('../package.json');
  return pkgJson.version;
}

/** The file name stem of a request: the same state and questions always share it. */
export function requestKey(req: JudgeRequest): string {
  return createHash('sha256')
    .update(JSON.stringify({ state: req.state, questions: req.questions }))
    .digest('hex');
}

function isErrnoCode(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === code;
}

function recordIo(message: string, cause: unknown): VetError {
  return new VetError(CEV_ERROR_CODES.E_IO, redact(message), { cause });
}

/** Wraps `judge`: same identity and answers, and every response is also written under `dir`. */
export function recordingJudge(judge: JudgeV1, dir: string, options: { version: string }): JudgeV1 {
  const manifest: Manifest = {
    recordVersion: RECORD_VERSION,
    vetkit: options.version,
    judge: { id: judge.id, capabilities: judge.capabilities },
  };
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, MANIFEST), JSON.stringify(manifest), 'utf8');
  } catch (err) {
    throw recordIo(`cannot write recording manifest in ${dir}`, err);
  }
  return {
    specVersion: judge.specVersion,
    id: judge.id,
    capabilities: judge.capabilities,
    async doJudge(req) {
      const response = await judge.doJudge(req);
      const body: Recorded = {
        answers: response.answers,
        usage: response.usage,
        model: response.model,
      };
      const file = join(dir, `${requestKey(req)}.json`);
      // Atomic like the verdict cache: identical requests in flight write the same key.
      const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
      try {
        await mkdir(dir, { recursive: true });
        await writeFile(tmp, JSON.stringify(body), 'utf8');
        await rename(tmp, file);
      } catch (err) {
        await rm(tmp, { force: true }).catch(() => undefined);
        throw recordIo(`cannot write recording ${file}`, err);
      }
      return response;
    },
  };
}

function readManifest(dir: string): Manifest {
  const file = join(dir, MANIFEST);
  const invalid = (why: string, cause?: unknown): VetError =>
    new VetError(CEV_ERROR_CODES.CONFIG_INVALID, redact(`cannot use recording ${file}: ${why}`), {
      cause,
    });
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    throw invalid('cannot read it', err);
  }
  const parsed = safeParseJson<Manifest>(text, manifestSchema);
  if (!parsed.ok) throw invalid('it is not a valid manifest', parsed.error);
  if (parsed.value.recordVersion !== RECORD_VERSION) {
    throw invalid(`recordVersion ${String(parsed.value.recordVersion)} is not supported`);
  }
  return parsed.value;
}

export interface ReplayOptions {
  /** The running CLI version; a manifest written by another one is reported through onWarn. */
  readonly version?: string;
  readonly onWarn?: (message: string) => void;
}

function miss(why: string): VetError {
  return new VetError(CEV_ERROR_CODES.JUDGE_UNAVAILABLE, why, { details: { hint: REPLAY_MISS } });
}

/** A judge that answers from the recording under `dir` and never touches the network. */
export function replayJudge(dir: string, options: ReplayOptions = {}): JudgeV1 {
  const manifest = readManifest(dir);
  if (options.version !== undefined && manifest.vetkit !== options.version) {
    options.onWarn?.(
      `recording ${dir} was made by vetkit ${manifest.vetkit}, this is ${options.version}`,
    );
  }
  return {
    specVersion: 'v1',
    id: manifest.judge.id,
    capabilities: manifest.judge.capabilities,
    async doJudge(req) {
      let text: string;
      try {
        text = await readFile(join(dir, `${requestKey(req)}.json`), 'utf8');
      } catch (err) {
        if (isErrnoCode(err, 'ENOENT')) throw miss('no recorded response for this request');
        throw recordIo(`cannot read recording under ${dir}`, err);
      }
      const parsed = safeParseJson<Recorded>(text, recordedSchema);
      if (!parsed.ok) throw miss('the recorded response for this request is unreadable');
      return parsed.value;
    },
  };
}
