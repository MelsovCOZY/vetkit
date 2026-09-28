import { expectTypeOf, test } from 'vitest';
import type { Case, Criterion, Lock } from '../generated/index.ts';
import { defineExporter } from './exporter.ts';
import type { ExporterV1 } from './exporter.ts';

const doExport = (): Promise<{ files: string[] }> => Promise.resolve({ files: [] });

test('ExporterV1.doExport returns Promise<{ files: string[] }>', () => {
  expectTypeOf<ExporterV1['doExport']>().returns.toEqualTypeOf<Promise<{ files: string[] }>>();
});

test('ExporterV1.doExport takes criteria, cases, lock and outDir', () => {
  expectTypeOf<ExporterV1['doExport']>().parameter(0).toEqualTypeOf<{
    criteria: Criterion[];
    cases: Case[];
    lock: Lock | null;
    outDir: string;
  }>();
});

test('defineExporter accepts a v1 exporter without kind or capabilities and returns ExporterV1', () => {
  expectTypeOf(
    defineExporter({ specVersion: 'v1', id: 'vitest', doExport }),
  ).toEqualTypeOf<ExporterV1>();
});

test('defineExporter rejects an exporter without id at the type level', () => {
  // @ts-expect-error id is required
  defineExporter({ specVersion: 'v1', doExport });
});

test("defineExporter rejects specVersion 'v2' at the type level", () => {
  // @ts-expect-error specVersion must be 'v1'
  defineExporter({ specVersion: 'v2', id: 'vitest', doExport });
});
