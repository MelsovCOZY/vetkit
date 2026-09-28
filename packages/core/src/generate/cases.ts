// Case extraction: each trace becomes one Case whose state is the transcript rendered as
// `role: content` lines (tool calls and responses inlined as JSON). Rendering is
// deterministic, so the same trace always gives the same state and the verdict cache hits.
// Generated cases never carry `expected`: references come only from the user or from code.
import { createHash } from 'node:crypto';
import type { Case, Criterion, Message, MessagePart, NormalizedTrace } from '@vetkit/spec';
import { MAX_STATE_TOKENS } from '../cases/load.ts';
import { statusForTrace, type ExclusionStatus } from '../judge/completeness.ts';

/** Bump when rendering changes: it is part of every case id. */
export const CASE_RENDERER_VERSION = '1';

const MAX_STATE_CHARS = MAX_STATE_TOKENS * 4;
const TRUNCATION_MARKER = '[truncated]\n';

export type TraceStatus =
  | { readonly traceId: string; readonly status: 'ok' | 'truncated' }
  | {
      readonly traceId: string;
      readonly status: 'not_applicable';
      readonly reason: ExclusionStatus | 'no_conversation';
    };

export interface ExtractCasesInput {
  readonly traces: readonly NormalizedTrace[];
  /** The criteria the cases are generated for (not used by rendering). */
  readonly criteria: readonly Criterion[];
}

export interface ExtractCasesResult {
  readonly cases: Case[];
  readonly traces: TraceStatus[];
}

function renderPart(part: MessagePart): string {
  switch (part.type) {
    case 'text':
      return part.content;
    case 'tool_call':
      return JSON.stringify({
        tool_call: { id: part.id, name: part.name, arguments: part.arguments },
      });
    case 'tool_call_response':
      return JSON.stringify({ tool_call_response: { id: part.id, response: part.response } });
    default:
      return '';
  }
}

function renderMessage(message: Message): string {
  const body = message.parts
    .map((part) => renderPart(part))
    .filter((text) => text !== '')
    .join('\n');
  return `${message.role}: ${body}`;
}

function finalAnswer(messages: readonly Message[]): string | undefined {
  const last = messages.findLast((m) => m.role === 'assistant');
  if (last === undefined) return undefined;
  const text = last.parts
    .flatMap((part) => (part.type === 'text' ? [part.content] : []))
    .join('\n');
  return text === '' ? undefined : text;
}

function caseId(traceId: string): string {
  return createHash('sha256').update(`${traceId}\n${CASE_RENDERER_VERSION}`).digest('hex');
}

export function extractCases(input: ExtractCasesInput): ExtractCasesResult {
  const cases: Case[] = [];
  const traces: TraceStatus[] = [];
  for (const trace of input.traces) {
    const { traceId } = trace;
    const completenessStatus = statusForTrace(trace);
    if (completenessStatus !== 'ok') {
      traces.push({ traceId, status: 'not_applicable', reason: completenessStatus });
      continue;
    }
    if (!trace.messages.some((m) => m.role !== 'system')) {
      traces.push({ traceId, status: 'not_applicable', reason: 'no_conversation' });
      continue;
    }

    const full = trace.messages.map((m) => renderMessage(m)).join('\n');
    const truncated = full.length > MAX_STATE_CHARS;
    // Keep the end: the final answer is what criteria judge.
    const state = truncated
      ? TRUNCATION_MARKER + full.slice(-(MAX_STATE_CHARS - TRUNCATION_MARKER.length))
      : full;
    const answer = finalAnswer(trace.messages);

    cases.push({
      id: caseId(traceId),
      input: answer === undefined ? { state } : { state, answer },
      traceId,
      provenance: { traceIds: [traceId] },
      tags: truncated ? ['truncated'] : [],
    });
    traces.push({ traceId, status: truncated ? 'truncated' : 'ok' });
  }
  return { cases, traces };
}
