import { expectTypeOf, test } from 'vitest';
import { defineSink } from '../index.ts';
import type { SinkAck, SinkV1, Verdict } from '../index.ts';

const doWrite = (): Promise<SinkAck> => Promise.resolve({ accepted: [], rejected: [] });

test('SinkV1, SinkAck and defineSink are importable from the @vetkit/spec index', () => {
  expectTypeOf(defineSink).toEqualTypeOf<(x: SinkV1) => SinkV1>();
  expectTypeOf<SinkAck>().toEqualTypeOf<{
    accepted: string[];
    rejected: Array<{ id: string; reason: string; retryable: boolean }>;
  }>();
});

test('Verdict.provenance.traceId reads as string | undefined', () => {
  expectTypeOf<NonNullable<Verdict['provenance']>['traceId']>().toEqualTypeOf<string | undefined>();
});

test('Verdict.id reads as string | undefined', () => {
  expectTypeOf<Verdict['id']>().toEqualTypeOf<string | undefined>();
});

test('SinkV1.doWrite takes a Verdict batch plus an optional signal and returns Promise<SinkAck>', () => {
  expectTypeOf<SinkV1['doWrite']>().parameter(0).toEqualTypeOf<Verdict[]>();
  expectTypeOf<SinkV1['doWrite']>().parameter(1).toEqualTypeOf<{ signal?: AbortSignal }>();
  expectTypeOf<SinkV1['doWrite']>().returns.toEqualTypeOf<Promise<SinkAck>>();
});

test('SinkV1 has no kind key and capabilities is exactly { batch; idempotent }', () => {
  expectTypeOf<SinkV1>().not.toHaveProperty('kind');
  expectTypeOf<SinkV1['capabilities']>().toEqualTypeOf<{ batch: number; idempotent: boolean }>();
});

test("defineSink rejects specVersion 'v2' at the type level", () => {
  // @ts-expect-error specVersion must be 'v1'
  defineSink({
    specVersion: 'v2',
    id: 'otel/logs',
    capabilities: { batch: 1, idempotent: true },
    doWrite,
  });
});

test('defineSink rejects a sink without capabilities at the type level', () => {
  // @ts-expect-error capabilities is required
  defineSink({ specVersion: 'v1', id: 'otel/logs', doWrite });
});
