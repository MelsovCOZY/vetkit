// Pure Verdict -> OTLP/JSON encoding for the gen_ai.evaluation.result event (docs/sinks.md
// "otel"). Built by hand: there is no SDK emission API for this event, and the OTLP/JSON
// shape (hex ids, lowerCamelCase, string int64s) is small enough to own
// (https://opentelemetry.io/docs/specs/otlp/).
import type { Verdict } from '@vetkit/spec';

// RISK: the GenAI semconv is Development status. Attribute names pinned from
// open-telemetry/semantic-conventions-genai docs/gen-ai/gen-ai-events.md at commit
// 5ca9052bc796ef1e497200b1d558fd87a201f335 (read 2026-09-25); schema URL from that repo's
// model/manifest.yaml.
export const SEMCONV_SCHEMA_URL = 'https://opentelemetry.io/schemas/gen-ai-dev/1.42.0-dev';
export const EVENT_NAME = 'gen_ai.evaluation.result';
const ATTR = {
  name: 'gen_ai.evaluation.name',
  scoreValue: 'gen_ai.evaluation.score.value',
  scoreLabel: 'gen_ai.evaluation.score.label',
  explanation: 'gen_ai.evaluation.explanation',
  responseId: 'gen_ai.response.id',
  errorType: 'error.type',
} as const;

// OTLP/gRPC's default 4 MiB message limit; the HTTP body is kept under it too.
export const MAX_BODY_BYTES: number = 4 * 1024 * 1024;

const TRACE_ID = /^[0-9a-f]{32}$/i;
const SPAN_ID = /^[0-9a-f]{16}$/i;

type AnyValue = { stringValue: string } | { doubleValue: number } | { boolValue: boolean };

export interface OtlpAttribute {
  key: string;
  value: AnyValue;
}

export interface OtlpLogRecord {
  timeUnixNano: string;
  observedTimeUnixNano: string;
  eventName: string;
  traceId?: string;
  spanId?: string;
  attributes: OtlpAttribute[];
}

export type CorrelationProblem = 'no correlation id' | 'invalid correlation id';

// The correlation rule (docs/sinks.md "Correlation"): trace/span ids from provenance, else
// gen_ai.response.id; with neither, the verdict cannot be placed.
export function correlationProblem(verdict: Verdict): CorrelationProblem | undefined {
  const { traceId, spanId, responseId } = verdict.provenance ?? {};
  if (traceId === undefined && responseId === undefined) return 'no correlation id';
  if (traceId !== undefined && !TRACE_ID.test(traceId)) return 'invalid correlation id';
  if (spanId !== undefined && !SPAN_ID.test(spanId)) return 'invalid correlation id';
  return undefined;
}

function str(key: string, value: string): OtlpAttribute {
  return { key, value: { stringValue: value } };
}

function num(v: number): string {
  return v.toFixed(2);
}

function verdictWord(pass: boolean): string {
  return pass ? 'pass' : 'fail';
}

function scoreAttributes(verdict: Verdict): OtlpAttribute[] {
  const { answer, criterionId } = verdict;
  if (answer === undefined) return [];
  let value: number;
  let label: string;
  let explanation: string;
  if (answer.type === 'boolean') {
    const p = answer.probability ?? 0;
    const threshold = verdict.threshold ?? 0.5;
    label = verdictWord(verdict.pass ?? p >= threshold);
    value = p;
    explanation = `${criterionId}: p=${num(p)} ${p >= threshold ? '>=' : '<'} threshold ${num(threshold)} → ${label}`;
  } else if (answer.type === 'choice') {
    label = answer.choice ?? '';
    value = verdict.pass === true ? 1 : 0;
    explanation = `${criterionId}: choice=${label} confidence=${num(answer.confidence ?? 0)} → ${verdictWord(verdict.pass === true)}`;
  } else {
    value = answer.score ?? 0;
    label = answer.legend?.[String(Math.round(value))] ?? String(Math.round(value));
    explanation = `${criterionId}: score=${num(value)} (${label})`;
    if (verdict.pass !== undefined) explanation += ` → ${verdictWord(verdict.pass)}`;
  }
  return [
    { key: ATTR.scoreValue, value: { doubleValue: value } },
    str(ATTR.scoreLabel, label),
    str(ATTR.explanation, explanation),
  ];
}

export function verdictToLogRecord(verdict: Verdict, nowMs: number = Date.now()): OtlpLogRecord {
  const provenance = verdict.provenance ?? {};
  const attributes: OtlpAttribute[] = [str(ATTR.name, verdict.criterionId)];
  if (verdict.status === 'ok') attributes.push(...scoreAttributes(verdict));
  else attributes.push(str(ATTR.errorType, verdict.status));
  if (provenance.responseId !== undefined) {
    attributes.push(str(ATTR.responseId, provenance.responseId));
  }
  attributes.push(
    str('classified_evals.model.resolved', verdict.model.resolved),
    str('classified_evals.model.transport', verdict.model.transport),
    { key: 'classified_evals.model.pinned', value: { boolValue: verdict.model.pinned } },
    { key: 'classified_evals.cache_hit', value: { boolValue: verdict.cacheHit } },
  );
  const time = `${String(Math.trunc(nowMs))}000000`;
  return {
    timeUnixNano: time,
    observedTimeUnixNano: time,
    eventName: EVENT_NAME,
    ...(provenance.traceId !== undefined ? { traceId: provenance.traceId.toLowerCase() } : {}),
    ...(provenance.spanId !== undefined ? { spanId: provenance.spanId.toLowerCase() } : {}),
    attributes,
  };
}

export function encodeLogsBody(logRecords: OtlpLogRecord[]): string {
  return JSON.stringify({
    resourceLogs: [
      {
        resource: { attributes: [str('service.name', 'vetkit')] },
        scopeLogs: [
          {
            scope: { name: '@vetkit/sink-otel' },
            schemaUrl: SEMCONV_SCHEMA_URL,
            logRecords,
          },
        ],
      },
    ],
  });
}

export function byteLength(body: string): number {
  return new TextEncoder().encode(body).byteLength;
}
