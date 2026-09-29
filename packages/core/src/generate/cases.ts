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
  /** when true, also builds a Case for a non-ok trace that
   * still has a real conversation, with provenance `{traceIds, trace:{completeness}}` (the
   * `CaseTraceProvenance` shape judge/completeness.ts's `partitionCases` reads), so a caller
   * like the watch loop can still judge that trace's content-independent criteria. Default
   * false: `vet init` (generateEvals) never passes this, so its output is unchanged. */
  readonly includeIncomplete?: boolean;
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

// the span the conversation/LLM output came from: the llm-kind span whose messageRange covers
// the final assistant message. Undefined when no such span exists (e.g. no spans at all).
function answerSpanId(trace: NormalizedTrace): string | undefined {
  const index = trace.messages.findLastIndex((m) => m.role === 'assistant');
  if (index === -1) return undefined;
  return trace.spans.find(
    (span) =>
      span.kind === 'llm' &&
      span.messageRange !== undefined &&
      index >= span.messageRange[0] &&
      index < span.messageRange[1],
  )?.spanId;
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
    const hasConversation = trace.messages.some((m) => m.role !== 'system');

    if (completenessStatus !== 'ok') {
      traces.push({ traceId, status: 'not_applicable', reason: completenessStatus });
      // Default: a non-ok trace never gets a Case (vet init's output is unchanged). Opt-in:
      // still build one below, as long as there is a real conversation to render.
      if (input.includeIncomplete !== true || !hasConversation) continue;
    } else if (!hasConversation) {
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
    const spanId = answerSpanId(trace);
    const correlation = { traceId, ...(spanId === undefined ? {} : { spanId }) };

    cases.push({
      id: caseId(traceId),
      input: answer === undefined ? { state } : { state, answer },
      traceId,
      provenance:
        completenessStatus === 'ok'
          ? { traceIds: [traceId], ...correlation }
          : {
              traceIds: [traceId],
              trace: { completeness: trace.completeness },
              ...correlation,
            },
      tags: truncated ? ['truncated'] : [],
    });
    // The non-ok branch already pushed its not_applicable status above; only an ok trace
    // still needs its (ok|truncated) status recorded here.
    if (completenessStatus === 'ok')
      traces.push({ traceId, status: truncated ? 'truncated' : 'ok' });
  }
  return { cases, traces };
}
