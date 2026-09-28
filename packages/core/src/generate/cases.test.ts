import type { NormalizedTrace } from '@vetkit/spec';
import { describe, expect, test } from 'vitest';
import { MAX_STATE_TOKENS } from '../cases/load.ts';
import { extractCases } from './cases.ts';

function trace(traceId: string, extra: Partial<NormalizedTrace> = {}): NormalizedTrace {
  return {
    traceId,
    spans: [],
    messages: [
      { role: 'system', parts: [{ type: 'text', content: 'You are a support agent.' }] },
      { role: 'user', parts: [{ type: 'text', content: `Where is order ${traceId}?` }] },
      { role: 'assistant', parts: [{ type: 'text', content: `Order ${traceId} ships today.` }] },
    ],
    dialect: 'test',
    completeness: { contentCaptured: true, truncated: false, missingParents: false },
    ...extra,
  };
}

const uncaptured = (id: string): NormalizedTrace =>
  trace(id, {
    messages: [],
    completeness: { contentCaptured: false, truncated: false, missingParents: false },
  });

describe('extractCases', () => {
  test('renders a trace as role: content lines and sets the final assistant answer', () => {
    const { cases } = extractCases({ traces: [trace('t1')], criteria: [] });

    expect(cases).toHaveLength(1);
    const c = cases[0];
    expect(c?.input.state).toBe(
      [
        'system: You are a support agent.',
        'user: Where is order t1?',
        'assistant: Order t1 ships today.',
      ].join('\n'),
    );
    expect(c?.input.answer).toBe('Order t1 ships today.');
    expect(c?.traceId).toBe('t1');
    expect(c?.provenance).toEqual({ traceIds: ['t1'] });
    expect(c?.tags).not.toContain('truncated');
  });

  test('inlines tool calls and tool responses as JSON', () => {
    const t = trace('t2', {
      messages: [
        { role: 'user', parts: [{ type: 'text', content: 'Status of A1?' }] },
        {
          role: 'assistant',
          parts: [
            { type: 'tool_call', id: 'c1', name: 'lookup_order', arguments: { orderId: 'A1' } },
          ],
        },
        {
          role: 'tool',
          parts: [{ type: 'tool_call_response', id: 'c1', response: { status: 'shipped' } }],
        },
        { role: 'assistant', parts: [{ type: 'text', content: 'A1 has shipped.' }] },
      ],
    });

    const state = extractCases({ traces: [t], criteria: [] }).cases[0]?.input.state ?? '';

    expect(state).toContain('assistant: {');
    expect(state).toContain('"lookup_order"');
    expect(state).toContain('"orderId":"A1"');
    expect(state).toContain('tool: {');
    expect(state).toContain('"status":"shipped"');
    expect(state.endsWith('assistant: A1 has shipped.')).toBe(true);
  });

  test('is deterministic: same trace gives the same id and state; ids are sha256 hex per trace', () => {
    const a = extractCases({ traces: [trace('t1'), trace('t2')], criteria: [] }).cases;
    const b = extractCases({ traces: [trace('t1'), trace('t2')], criteria: [] }).cases;

    expect(a).toEqual(b);
    expect(a[0]?.id).toMatch(/^[0-9a-f]{64}$/);
    expect(a[0]?.id).not.toBe(a[1]?.id);
  });

  test('skips a trace whose content was not captured, reporting not_applicable', () => {
    const { cases, traces } = extractCases({
      traces: [uncaptured('t-none'), trace('t1')],
      criteria: [],
    });

    expect(cases.map((c) => c.traceId)).toEqual(['t1']);
    expect(traces).toContainEqual(
      expect.objectContaining({ traceId: 't-none', status: 'not_applicable' }),
    );
    expect(traces).toContainEqual(expect.objectContaining({ traceId: 't1', status: 'ok' }));
  });

  test('a trace with only system messages is not_applicable', () => {
    const t = trace('t-sys', {
      messages: [{ role: 'system', parts: [{ type: 'text', content: 'You are helpful.' }] }],
    });

    const { cases, traces } = extractCases({ traces: [t], criteria: [] });

    expect(cases).toHaveLength(0);
    expect(traces).toContainEqual(
      expect.objectContaining({ traceId: 't-sys', status: 'not_applicable' }),
    );
  });

  test('caps state at MAX_STATE_TOKENS (chars/4), keeps the end, and flags truncated', () => {
    const t = trace('t-big', {
      messages: [
        {
          role: 'user',
          parts: [{ type: 'text', content: 'x'.repeat(MAX_STATE_TOKENS * 4 + 5000) }],
        },
        { role: 'assistant', parts: [{ type: 'text', content: 'Final answer.' }] },
      ],
    });

    const { cases, traces } = extractCases({ traces: [t], criteria: [] });

    const c = cases[0];
    expect(Math.ceil((c?.input.state.length ?? Infinity) / 4)).toBeLessThanOrEqual(
      MAX_STATE_TOKENS,
    );
    expect(c?.input.state.endsWith('assistant: Final answer.')).toBe(true);
    expect(c?.tags).toContain('truncated');
    expect(c?.input.answer).toBe('Final answer.');
    expect(traces).toContainEqual(
      expect.objectContaining({ traceId: 't-big', status: 'truncated' }),
    );
  });

  test('never writes expected on any generated case', () => {
    const noAnswer = trace('t-q', {
      messages: [{ role: 'user', parts: [{ type: 'text', content: 'Hello?' }] }],
    });
    const { cases } = extractCases({ traces: [trace('t1'), noAnswer], criteria: [] });

    expect(cases).toHaveLength(2);
    for (const c of cases) expect(c).not.toHaveProperty('expected');
    expect(cases[1]).not.toHaveProperty('input.answer');
  });
});

// mol-pij.15 (J5 gate): extractCases must classify excluded traces by statusForTrace's
// completeness status, at the same priority (content_not_captured > truncated >
// incomplete_trace), instead of only ever reporting content_not_captured/no_conversation.
describe('extractCases: completeness-status exclusion (mol-pij.15)', () => {
  test('a completeness.truncated trace with real conversation is excluded, reason truncated', () => {
    const t = trace('t-truncated', {
      completeness: { contentCaptured: true, truncated: true, missingParents: false },
    });

    const { cases, traces } = extractCases({ traces: [t], criteria: [] });

    expect(cases).toHaveLength(0);
    expect(traces).toContainEqual({
      traceId: 't-truncated',
      status: 'not_applicable',
      reason: 'truncated',
    });
  });

  test('a missingParents trace with real conversation is excluded, reason incomplete_trace', () => {
    const t = trace('t-missing-parents', {
      completeness: { contentCaptured: true, truncated: false, missingParents: true },
    });

    const { cases, traces } = extractCases({ traces: [t], criteria: [] });

    expect(cases).toHaveLength(0);
    expect(traces).toContainEqual({
      traceId: 't-missing-parents',
      status: 'not_applicable',
      reason: 'incomplete_trace',
    });
  });

  test('content_not_captured takes priority over truncated', () => {
    const t = uncaptured('t-both-a');
    const bothFlags = trace('t-both-a', {
      messages: t.messages,
      completeness: { contentCaptured: false, truncated: true, missingParents: false },
    });

    const { traces } = extractCases({ traces: [bothFlags], criteria: [] });

    expect(traces).toContainEqual({
      traceId: 't-both-a',
      status: 'not_applicable',
      reason: 'content_not_captured',
    });
  });

  test('truncated takes priority over incomplete_trace', () => {
    const t = trace('t-both-b', {
      completeness: { contentCaptured: true, truncated: true, missingParents: true },
    });

    const { traces } = extractCases({ traces: [t], criteria: [] });

    expect(traces).toContainEqual({
      traceId: 't-both-b',
      status: 'not_applicable',
      reason: 'truncated',
    });
  });

  test('an ok-completeness trace with no conversation is still reported no_conversation', () => {
    const t = trace('t-sys2', {
      messages: [{ role: 'system', parts: [{ type: 'text', content: 'You are helpful.' }] }],
    });

    const { cases, traces } = extractCases({ traces: [t], criteria: [] });

    expect(cases).toHaveLength(0);
    expect(traces).toContainEqual({
      traceId: 't-sys2',
      status: 'not_applicable',
      reason: 'no_conversation',
    });
  });
});

// bead classified-evals-mol-dh8.4: includeIncomplete lets a watch-loop caller still build a
// Case for a non-ok trace that has a real conversation, so judge/completeness.ts's
// partitionCases can select the still-judgeable (contentDependent: false) criteria for it,
// instead of the whole trace being silently dropped.
describe('extractCases: includeIncomplete (mol-dh8.4)', () => {
  test('default (includeIncomplete omitted): a truncated trace with a real conversation still builds no case', () => {
    const t = trace('t-trunc', {
      completeness: { contentCaptured: true, truncated: true, missingParents: false },
    });

    const { cases, traces } = extractCases({ traces: [t], criteria: [] });

    expect(cases).toHaveLength(0);
    expect(traces).toContainEqual({
      traceId: 't-trunc',
      status: 'not_applicable',
      reason: 'truncated',
    });
  });

  test('includeIncomplete: true builds a Case for a truncated trace with a real conversation, provenance carrying completeness', () => {
    const completeness = { contentCaptured: true, truncated: true, missingParents: false };
    const t = trace('t-trunc', { completeness });

    const { cases, traces } = extractCases({
      traces: [t],
      criteria: [],
      includeIncomplete: true,
    });

    expect(cases).toHaveLength(1);
    expect(cases[0]?.provenance).toEqual({ traceIds: ['t-trunc'], trace: { completeness } });
    // The trace-status bookkeeping (used by vet init's `excluded` summary) is unchanged: this
    // trace is still reported not_applicable/truncated even though a Case now also exists for it.
    expect(traces).toContainEqual({
      traceId: 't-trunc',
      status: 'not_applicable',
      reason: 'truncated',
    });
  });

  test('includeIncomplete: true still builds no case for a non-ok trace with no real conversation', () => {
    const t = uncaptured('t-none-incomplete');

    const { cases, traces } = extractCases({
      traces: [t],
      criteria: [],
      includeIncomplete: true,
    });

    expect(cases).toHaveLength(0);
    expect(traces).toContainEqual({
      traceId: 't-none-incomplete',
      status: 'not_applicable',
      reason: 'content_not_captured',
    });
  });

  test('includeIncomplete: true does not change provenance or output for an ok trace', () => {
    const { cases } = extractCases({
      traces: [trace('t-ok')],
      criteria: [],
      includeIncomplete: true,
    });

    expect(cases[0]?.provenance).toEqual({ traceIds: ['t-ok'] });
  });
});
