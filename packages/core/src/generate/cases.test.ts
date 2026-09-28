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
