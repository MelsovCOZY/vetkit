// createJsonlSource: a SourceV1 over a folder of *.jsonl files. Files are read
// one at a time, in name order, only as the consumer pulls traces. Nested directories are not
// scanned. Failures never throw: they are reported through `onDiag` and the line or folder is
// skipped. The diag shape mirrors core's DiagEvent (adapters import only @vetkit/spec).

import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { CEV_ERROR_CODES, defineSource, type NormalizedTrace, type SourceV1 } from '@vetkit/spec';
import { parseLine } from './jsonl.ts';

export interface JsonlDiag {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly code: string;
  readonly message: string;
  readonly data?: Readonly<Record<string, number | boolean>>;
}

export interface CreateJsonlSourceOptions {
  /** Folder whose top-level *.jsonl files are read. */
  dir: string;
  onDiag?: (diag: JsonlDiag) => void;
}

const MAX_LINE_BYTES = 1024 * 1024;
const BOM = '\uFEFF';

export function createJsonlSource(options: CreateJsonlSourceOptions): SourceV1 {
  const { dir, onDiag } = options;
  const diag = (d: JsonlDiag): void => onDiag?.(d);

  async function listFiles(): Promise<string[] | undefined> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
        .map((entry) => entry.name)
        .toSorted();
    } catch {
      diag({
        level: 'warn',
        code: CEV_ERROR_CODES.SOURCE_UNREADABLE,
        message: `${dir}: folder cannot be read`,
      });
      return undefined;
    }
  }

  async function* readFile(path: string, signal?: AbortSignal): AsyncGenerator<NormalizedTrace> {
    const stream = createReadStream(path, { encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    let lineNo = 0;
    try {
      for await (const rawLine of lines) {
        signal?.throwIfAborted();
        lineNo += 1;
        const line = lineNo === 1 && rawLine.startsWith(BOM) ? rawLine.slice(1) : rawLine;
        if (line.trim() === '') continue;
        const result =
          Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES
            ? ({ ok: false, reason: 'line too large' } as const)
            : parseLine(line);
        if (result.ok) {
          yield result.trace;
        } else {
          diag({
            level: 'warn',
            code: CEV_ERROR_CODES.TRACE_INVALID,
            message: `${path}:${String(lineNo)} ${result.reason}`,
            data: { line: lineNo },
          });
        }
      }
    } catch (error) {
      if (signal?.aborted === true) throw error;
      diag({
        level: 'warn',
        code: CEV_ERROR_CODES.SOURCE_UNREADABLE,
        message: `${path}: file cannot be read`,
        data: { line: lineNo },
      });
    } finally {
      lines.close();
      stream.destroy();
    }
  }

  async function* doRead(opts: { signal?: AbortSignal }): AsyncGenerator<NormalizedTrace> {
    const files = await listFiles();
    if (files === undefined) return;
    if (files.length === 0) {
      diag({
        level: 'warn',
        code: CEV_ERROR_CODES.SOURCE_UNREADABLE,
        message: `${dir}: no *.jsonl files found`,
      });
      return;
    }
    for (const name of files) {
      opts.signal?.throwIfAborted();
      yield* readFile(join(dir, name), opts.signal);
    }
  }

  return defineSource({
    specVersion: 'v1',
    id: 'jsonl/traces',
    capabilities: { streaming: true, content: 'captured' },
    doRead,
  });
}
