// assessCompleteness: pure judgement of whether a trace's LLM content was
// actually captured intact -- never scores truncated or not-captured content as if it were
// complete (root acceptance J5). `reasons` is diagnostic only; a
// length-equals-limit match is a heuristic and false positives are acceptable (a truncated mark
// excludes a case from content-dependent criteria, it never fails one).

import type { OtlpSpan } from '../reader/index.ts';
import type { SpanTree } from '../reader/tree.ts';
import type { DialectV1 } from '../normalize/dialect.ts';

// SOURCE: https://opentelemetry.io/docs/specs/otel/configuration/sdk-environment-variables/
//   (OTEL_ATTRIBUTE_COUNT_LIMIT default: 128 attributes per span)
// SOURCE: https://docs.datadoghq.com/tracing/troubleshooting/
//   (APM intake truncates string attribute values at 25,000 chars; some pipelines cap at 65,536)
// SOURCE: https://github.com/langwatch/tasks/issues/399
//   (dropped attribute/event counts on a span are a truncation signal)
const KNOWN_LIMITS = { attrCount: 128, contentChars: [25_000, 65_536] } as const;

export interface CompletenessResult {
  readonly contentCaptured: boolean;
  readonly truncated: boolean;
  readonly missingParents: readonly string[];
  readonly reasons: string[];
}

export function assessCompleteness(
  tree: SpanTree,
  spans: readonly OtlpSpan[],
  dialect: DialectV1 | undefined,
): CompletenessResult {
  const reasons: string[] = [];

  if (dialect === undefined) {
    return {
      contentCaptured: false,
      truncated: false,
      missingParents: tree.missingParents,
      reasons,
    };
  }

  const llmSpans = spans.filter((s) => dialect.isLlmSpan(s));
  let truncated = false;

  for (const s of llmSpans) {
    if (s.droppedAttributesCount > 0) {
      truncated = true;
      reasons.push(`span ${s.spanId}: droppedAttributesCount ${s.droppedAttributesCount} > 0`);
    }
    if (s.droppedEventsCount > 0) {
      truncated = true;
      reasons.push(`span ${s.spanId}: droppedEventsCount ${s.droppedEventsCount} > 0`);
    }
    if (Object.keys(s.attributes).length === KNOWN_LIMITS.attrCount) {
      truncated = true;
      reasons.push(`span ${s.spanId}: exactly ${KNOWN_LIMITS.attrCount} attributes`);
    }
    for (const [key, value] of Object.entries(s.attributes)) {
      if (
        typeof value === 'string' &&
        (KNOWN_LIMITS.contentChars as readonly number[]).includes(value.length)
      ) {
        truncated = true;
        reasons.push(`span ${s.spanId}: attribute ${key} is exactly ${value.length} chars`);
      }
    }
    for (const message of dialect.extractMessages(s, tree)) {
      for (const part of message.parts) {
        if (part.type === 'parse_error') {
          truncated = true;
          reasons.push(`span ${s.spanId}: content failed to parse (${part.detail})`);
        }
      }
    }
  }

  // Vacuously false when there are no LLM spans at all: "every LLM span not_captured" holds.
  const contentCaptured = llmSpans.some((s) => dialect.contentState(s) !== 'not_captured');

  return { contentCaptured, truncated, missingParents: tree.missingParents, reasons };
}
