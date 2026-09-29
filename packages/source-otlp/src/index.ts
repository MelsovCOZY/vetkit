// Named re-exports only — no `export *` (oxc/no-barrel-file).
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import {
  CEV_ERROR_CODES,
  VetError,
  defineSource,
  type NormalizedTrace,
  type SourceV1,
} from '@vetkit/spec';
import {
  groupByTraceId,
  normalizeTrace,
  type DialectV1,
  type OtlpDiag,
} from './normalize/index.ts';
import { readOtlpJson } from './reader/index.ts';
import { buildSpanTree } from './reader/tree.ts';
import { DEFAULT_DIALECT_ORDER } from './default-dialects.ts';

export { DEFAULT_DIALECT_ORDER } from './default-dialects.ts';

export { readOtlpDir, readOtlpJson } from './reader/index.ts';
export type {
  AnyValue,
  IdEncoding,
  OtlpDecodeError,
  OtlpEvent,
  OtlpFileResult,
  OtlpLink,
  OtlpResource,
  OtlpResourceSpans,
  OtlpScopeSpans,
  OtlpSpan,
  OtlpStatus,
  ReadOtlpResult,
} from './reader/index.ts';
export { buildSpanTree } from './reader/tree.ts';
export type { SpanNode, SpanTree } from './reader/tree.ts';

export { startReceiver } from './receiver/index.ts';
export type { Receiver, StartReceiverOptions } from './receiver/index.ts';

export { detectDialect, groupByTraceId, normalizeTrace, sumTokens } from './normalize/index.ts';
export type { DialectV1, OtlpDiag, TraceGroup } from './normalize/index.ts';

export interface OtlpSourceOptions {
  files?: string[];
  dialects?: readonly DialectV1[];
  onDiag?: (d: OtlpDiag) => void;
}

// otlpSource: a SourceV1 over a fixed list of OTLP/JSON files. It groups spans into per-trace
// SpanTrees and cascades through `opts.dialects`. `opts.dialects` undefined falls back to
// DEFAULT_DIALECT_ORDER; an explicit `[]` still means every trace normalises to 'unknown'.
// A receiver (`opts.listen`) is not supported here.
export function otlpSource(opts: OtlpSourceOptions): SourceV1 {
  const dialects = opts.dialects ?? DEFAULT_DIALECT_ORDER;
  const files = opts.files ?? [];

  async function* doRead(): AsyncGenerator<NormalizedTrace> {
    let count = 0;
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      const lines =
        extname(file) === '.jsonl' ? text.split('\n').filter((line) => line.trim() !== '') : [text];
      for (const line of lines) {
        const result = readOtlpJson(line);
        if ('error' in result) {
          throw new VetError(CEV_ERROR_CODES.OTLP_PARSE, result.detail);
        }
        for (const group of groupByTraceId(result.resourceSpans)) {
          const tree = buildSpanTree(group.spans);
          yield normalizeTrace(tree, group.resource, dialects, opts.onDiag, group.traceId);
          count += 1;
        }
      }
    }
    if (count === 0) {
      throw new VetError(CEV_ERROR_CODES.SOURCE_EMPTY, 'otlp source produced no traces');
    }
  }

  return defineSource({
    specVersion: 'v1',
    id: 'otlp/file',
    capabilities: { streaming: true, content: 'maybe' },
    doRead,
  });
}
