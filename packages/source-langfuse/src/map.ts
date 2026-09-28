// map.ts — Langfuse trace + observations -> NormalizedTrace (bead mol-yxn.5). Only GENERATION
// observations become messages, in start-time order: `input` becomes one message per chat turn
// when it is an array of {role, content} entries (the common shape for a GENERATION's prompt),
// otherwise it is wrapped as one 'user' message; `output` becomes one 'assistant' message.
// NormalizedTrace carries no provenance field (packages/spec/schemas/trace.schema.json has none,
// and it is not planned there — only on the not-yet-implemented Verdict, docs/contracts/j6.md),
// so provenance (the trace id and the last generation's observation id) is recorded as
// attributes on that last generation's span (orchestrator DECISION, mol-yxn.5 premise repair).

import type { Message, NormalizedTrace, Span } from '@vetkit/spec';

/** The `Observation`/`ObservationsView` fields this adapter reads (Langfuse OpenAPI spec,
 *  raw.githubusercontent.com/langfuse/langfuse/main/web/public/generated/api/openapi.yml,
 *  verified 2026-09-29). `type` is a free string in the schema; 'GENERATION' is the value
 *  Langfuse's own docs use for observations that wrap an LLM call. */
export interface LangfuseObservation {
  readonly id: string;
  readonly type: string;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly startTime: string;
  readonly endTime?: string | null;
  readonly usage?: { readonly output?: number } | null;
  readonly usageDetails?: Readonly<Record<string, number>>;
  readonly metadata?: unknown;
}

/** The `Trace` fields this adapter reads (same OpenAPI source as {@link LangfuseObservation}). */
export interface LangfuseTraceCore {
  readonly id: string;
}

const CHAT_ROLES = new Set(['system', 'user', 'assistant', 'tool']);

function stringifyContent(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function isChatTurn(item: unknown): item is { role: string; content?: unknown } {
  if (typeof item !== 'object' || item === null || !('role' in item)) return false;
  return typeof item.role === 'string' && CHAT_ROLES.has(item.role);
}

function isChatMessageArray(value: unknown): value is Array<{ role: string; content?: unknown }> {
  return Array.isArray(value) && value.length > 0 && value.every(isChatTurn);
}

function inputMessages(input: unknown): Message[] {
  if (input === null || input === undefined) return [];
  if (isChatMessageArray(input)) {
    return input.map((turn) => ({
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      role: turn.role as Message['role'],
      parts: [{ type: 'text', content: stringifyContent(turn.content) }],
    }));
  }
  return [{ role: 'user', parts: [{ type: 'text', content: stringifyContent(input) }] }];
}

function isEmptyOutput(output: unknown): boolean {
  if (output === null || output === undefined || output === '') return true;
  return Array.isArray(output) && output.length === 0;
}

function completionTokenCount(observation: LangfuseObservation): number {
  return observation.usage?.output ?? observation.usageDetails?.['output'] ?? 0;
}

function reportsTruncated(observation: LangfuseObservation): boolean {
  const metadata = observation.metadata;
  if (typeof metadata !== 'object' || metadata === null || !('truncated' in metadata)) {
    return false;
  }
  return metadata.truncated === true;
}

/** Maps one Langfuse trace and its observations (any type; GENERATION ones are filtered and
 *  sorted by start-time here) to a NormalizedTrace. */
export function mapLangfuseTrace(
  trace: LangfuseTraceCore,
  observations: readonly LangfuseObservation[],
): NormalizedTrace {
  const generations = observations
    .filter((observation) => observation.type === 'GENERATION')
    .toSorted((a, b) => a.startTime.localeCompare(b.startTime));

  const messages: Message[] = [];
  const spans: Span[] = [];

  for (const generation of generations) {
    const startIndex = messages.length;
    messages.push(...inputMessages(generation.input));
    if (generation.output !== null && generation.output !== undefined) {
      messages.push({
        role: 'assistant',
        parts: [{ type: 'text', content: stringifyContent(generation.output) }],
      });
    }
    const endIndex = messages.length;

    const span: Span = {
      spanId: generation.id,
      name: generation.type,
      kind: 'llm',
      startTime: generation.startTime,
    };
    if (generation.endTime !== null && generation.endTime !== undefined) {
      span.endTime = generation.endTime;
    }
    if (endIndex > startIndex) span.messageRange = [startIndex, endIndex - 1];
    spans.push(span);
  }

  const lastGeneration = generations.at(-1);
  const lastSpan = spans.at(-1);
  if (lastGeneration !== undefined && lastSpan !== undefined) {
    lastSpan.attributes = {
      'langfuse.trace.id': trace.id,
      'langfuse.observation.id': lastGeneration.id,
    };
  }

  const contentCaptured =
    generations.length > 0 && generations.every((g) => !(g.input == null && g.output == null));

  const truncated = generations.some(
    (g) => reportsTruncated(g) || (isEmptyOutput(g.output) && completionTokenCount(g) > 0),
  );

  return {
    traceId: trace.id,
    spans,
    messages,
    dialect: 'langfuse',
    completeness: { contentCaptured, truncated, missingParents: false },
  };
}
