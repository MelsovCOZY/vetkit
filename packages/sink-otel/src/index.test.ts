import { describe, expect, test } from 'vitest';
import {
  createOpenInferenceSink,
  createOtelSink,
  encodeTracesBody,
  verdictToLogRecord,
  verdictToSpan,
} from './index.ts';

describe('@vetkit/sink-otel package entry', () => {
  test('re-exports createOtelSink as a function', () => {
    expect(typeof createOtelSink).toBe('function');
  });

  test('re-exports verdictToLogRecord as a function', () => {
    expect(typeof verdictToLogRecord).toBe('function');
  });

  test('createOtelSink returns a v1 sink with id otel/logs', () => {
    const sink = createOtelSink({ endpoint: 'http://collector:4318' });
    expect(sink.specVersion).toBe('v1');
    expect(sink.id).toBe('otel/logs');
  });

  test('re-exports createOpenInferenceSink as a function', () => {
    expect(typeof createOpenInferenceSink).toBe('function');
  });

  test('createOpenInferenceSink returns a v1 sink with id otel/openinference', () => {
    const sink = createOpenInferenceSink({ endpoint: 'http://collector:4318' });
    expect(sink.specVersion).toBe('v1');
    expect(sink.id).toBe('otel/openinference');
  });

  test('re-exports verdictToSpan and encodeTracesBody as functions', () => {
    expect(typeof verdictToSpan).toBe('function');
    expect(typeof encodeTracesBody).toBe('function');
  });
});
