import { describe, expect, test } from 'vitest';
import { VetError } from '../errors.ts';
import { defineExporter } from './exporter.ts';
import type { ExporterV1 } from './exporter.ts';

function makeExporter(overrides: Partial<ExporterV1> = {}): ExporterV1 {
  return {
    specVersion: 'v1',
    id: 'vitest',
    doExport: () => Promise.resolve({ files: ['out/case.test.ts'] }),
    ...overrides,
  };
}

describe('defineExporter', () => {
  test('returns a v1 exporter unchanged (same object)', () => {
    const exporter = makeExporter();
    expect(defineExporter(exporter)).toBe(exporter);
  });

  test("rejects specVersion 'v2' with E_ADAPTER_SPEC_VERSION naming the id", () => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const exporter = { ...makeExporter(), specVersion: 'v2' } as unknown as ExporterV1;
    let caught: unknown;
    try {
      defineExporter(exporter);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(VetError);
    expect(caught).toMatchObject({
      code: 'E_ADAPTER_SPEC_VERSION',
      message: expect.stringContaining('vitest'),
    });
  });

  test('leaves doExport untouched so a rejection propagates to the caller', async () => {
    const failure = new Error('disk full');
    const doExport = (): Promise<{ files: string[] }> => Promise.reject(failure);
    const exporter = defineExporter(makeExporter({ doExport }));
    expect(exporter.doExport).toBe(doExport);
    await expect(
      exporter.doExport({ criteria: [], cases: [], lock: null, outDir: 'out' }),
    ).rejects.toBe(failure);
  });
});
