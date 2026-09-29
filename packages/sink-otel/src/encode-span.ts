// Pure Verdict -> OTLP/JSON span encoding for the OpenInference EVALUATOR carrier.
// The target span has ended, so feedback rides on a NEW span that has
// exactly one Span Link to the target and no parent
// (https://github.com/Arize-ai/openinference/blob/main/spec/annotations.md).
import { randomBytes } from 'node:crypto';
import type { Verdict } from '@vetkit/spec';
import { errorType, verdictToLogRecord, type OtlpAttribute } from './encode.ts';

// RISK: `evaluations.<i>.evaluation.*` taken from the annotations spec read 2026-09-25.
const EV = 'evaluations.0.evaluation';
const SPAN_KIND_INTERNAL = 1;

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  links: Array<{ traceId: string; spanId: string }>;
  attributes: OtlpAttribute[];
}

function str(key: string, value: string): OtlpAttribute {
  return { key, value: { stringValue: value } };
}

function causeText(verdict: Verdict): string {
  const { cause } = verdict;
  if (typeof cause === 'string') return cause;
  if (cause instanceof Error) return cause.message;
  return JSON.stringify(cause) ?? verdict.status;
}

// Score, label and explanation are read off the gen_ai.evaluation.result record so the two
// carriers never disagree on the mapping.
function evaluationAttributes(verdict: Verdict): OtlpAttribute[] {
  if (verdict.status !== 'ok') {
    return [
      str('error.type', errorType(verdict)),
      str(`${EV}.label`, verdict.status),
      str(`${EV}.explanation`, causeText(verdict)),
    ];
  }
  const out: OtlpAttribute[] = [];
  for (const { key, value } of verdictToLogRecord(verdict).attributes) {
    if (key === 'gen_ai.evaluation.score.value') out.push({ key: `${EV}.score`, value });
    else if (key === 'gen_ai.evaluation.score.label') out.push({ key: `${EV}.label`, value });
    else if (key === 'gen_ai.evaluation.explanation') out.push({ key: `${EV}.explanation`, value });
  }
  return out;
}

// The caller has validated provenance.traceId/spanId (both present, hex).
export function verdictToSpan(verdict: Verdict, nowMs: number = Date.now()): OtlpSpan {
  const { traceId = '', spanId = '' } = verdict.provenance ?? {};
  const time = `${String(Math.trunc(nowMs))}000000`;
  return {
    traceId: randomBytes(16).toString('hex'),
    spanId: randomBytes(8).toString('hex'),
    name: 'vet.evaluate',
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: time,
    endTimeUnixNano: time,
    links: [{ traceId: traceId.toLowerCase(), spanId: spanId.toLowerCase() }],
    attributes: [
      str('openinference.span.kind', 'EVALUATOR'),
      str(`${EV}.name`, verdict.criterionId),
      ...evaluationAttributes(verdict),
      str(`${EV}.annotator_kind`, 'JEV'),
      str(`${EV}.identifier`, verdict.id ?? ''),
      str('classified_evals.model.resolved', verdict.model.resolved),
      str('classified_evals.model.transport', verdict.model.transport),
      { key: 'classified_evals.model.pinned', value: { boolValue: verdict.model.pinned } },
    ],
  };
}

export function encodeTracesBody(spans: OtlpSpan[]): string {
  return JSON.stringify({
    resourceSpans: [
      {
        resource: { attributes: [str('service.name', 'vetkit')] },
        scopeSpans: [{ scope: { name: '@vetkit/sink-otel' }, spans }],
      },
    ],
  });
}
