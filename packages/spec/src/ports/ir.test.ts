import { describe, expect, test } from 'vitest';
import { traceSchema } from '../generated/schemas.ts';
import { validateJson } from '../json.ts';

// trace.schema.json cases. Validating through the generated traceSchema constant keeps
// this file inside the tsc project and off raw JSON.parse.

const completeness = { contentCaptured: true, truncated: false, missingParents: false };

function trace(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    traceId: '0af7651916cd43dd8448eb211c80319c',
    spans: [{ spanId: 'b7ad6b7169203331', name: 'chat' }],
    messages: [],
    dialect: 'otel-genai',
    completeness,
    ...overrides,
  };
}

function span(messageRange: unknown): Record<string, unknown> {
  return { spanId: 's1', name: 'chat', messageRange };
}

function accepts(value: unknown): boolean {
  return validateJson(value, traceSchema).ok;
}

describe('trace.schema.json', () => {
  test('accepts a trace with completeness flags and text, tool_call and tool_call_response parts', () => {
    const value = trace({
      schemaUrl: 'https://opentelemetry.io/schemas/1.37.0',
      messages: [
        { role: 'system', parts: [{ type: 'text', content: 'You are a support agent.' }] },
        { role: 'user', parts: [{ type: 'text', content: 'Refund order 42.' }] },
        {
          role: 'assistant',
          parts: [{ type: 'tool_call', id: 'call_1', name: 'refund', arguments: { orderId: 42 } }],
        },
        {
          role: 'tool',
          parts: [{ type: 'tool_call_response', id: 'call_1', response: { status: 'queued' } }],
        },
      ],
      completeness: { contentCaptured: true, truncated: true, missingParents: true },
    });
    expect(accepts(value)).toBe(true);
  });

  test("rejects a message with the unknown role 'bot'", () => {
    const value = trace({ messages: [{ role: 'bot', parts: [{ type: 'text', content: 'hi' }] }] });
    expect(accepts(value)).toBe(false);
  });

  test('accepts zero messages with spans present and contentCaptured false', () => {
    const value = trace({
      messages: [],
      completeness: { contentCaptured: false, truncated: false, missingParents: false },
    });
    expect(accepts(value)).toBe(true);
  });

  test('rejects a trace missing completeness', () => {
    const value = trace();
    delete value['completeness'];
    expect(accepts(value)).toBe(false);
  });

  test('accepts tokens with input, output and total non-negative integers', () => {
    expect(accepts(trace({ tokens: { input: 10, output: 5, total: 15 } }))).toBe(true);
  });

  test('accepts tokens with only a total (no input/output split)', () => {
    expect(accepts(trace({ tokens: { total: 15 } }))).toBe(true);
  });

  test('accepts a trace with tokens absent', () => {
    expect(accepts(trace())).toBe(true);
  });

  test('rejects negative tokens', () => {
    expect(accepts(trace({ tokens: { input: -1, output: 5, total: 4 } }))).toBe(false);
  });

  test('rejects fractional tokens', () => {
    expect(accepts(trace({ tokens: { input: 1.5, output: 5, total: 6.5 } }))).toBe(false);
  });

  test('accepts a span with kind and a two-integer messageRange', () => {
    const value = trace({
      spans: [
        { spanId: 's1', name: 'chat', kind: 'llm', messageRange: [0, 2] },
        { spanId: 's2', parentSpanId: 's1', name: 'refund', kind: 'tool' },
        { spanId: 's3', name: 'other', kind: 'other' },
      ],
    });
    expect(accepts(value)).toBe(true);
  });

  test("rejects a span kind outside 'llm' | 'tool' | 'other'", () => {
    expect(accepts(trace({ spans: [{ spanId: 's1', name: 'chat', kind: 'agent' }] }))).toBe(false);
  });

  test('rejects a messageRange that is not exactly two non-negative integers', () => {
    expect(accepts(trace({ spans: [span([0, 1, 2])] }))).toBe(false);
    expect(accepts(trace({ spans: [span([0])] }))).toBe(false);
    expect(accepts(trace({ spans: [span([-1, 2])] }))).toBe(false);
  });

  test('accepts a dialectVersion string next to dialect', () => {
    expect(accepts(trace({ dialect: 'unknown', dialectVersion: '1.37.0' }))).toBe(true);
  });

  test('accepts a parse_error part carrying a detail string', () => {
    const value = trace({
      messages: [
        { role: 'assistant', parts: [{ type: 'parse_error', detail: 'Unexpected token } at 12' }] },
      ],
    });
    expect(accepts(value)).toBe(true);
  });

  test('rejects an OTel reasoning part (sources drop it; the IR holds the visible exchange)', () => {
    const value = trace({
      messages: [{ role: 'assistant', parts: [{ type: 'reasoning', content: 'thinking' }] }],
    });
    expect(accepts(value)).toBe(false);
  });

  test("rejects a text part spelled {type:'text', text} instead of content", () => {
    const value = trace({ messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }] });
    expect(accepts(value)).toBe(false);
  });
});
