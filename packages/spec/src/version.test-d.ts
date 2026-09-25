import { expectTypeOf, test } from 'vitest';
import { ADAPTER_KINDS, type AdapterKind, SPEC_VERSION, type SpecVersion } from './version.ts';

test('SpecVersion is the literal type "v1"', () => {
  expectTypeOf<SpecVersion>().toEqualTypeOf<'v1'>();
  expectTypeOf(SPEC_VERSION).toEqualTypeOf<'v1'>();
});

test('AdapterKind is the union source|generator|judge|sink|exporter', () => {
  expectTypeOf<AdapterKind>().toEqualTypeOf<
    'source' | 'generator' | 'judge' | 'sink' | 'exporter'
  >();
  expectTypeOf(ADAPTER_KINDS).toEqualTypeOf<
    readonly ['source', 'generator', 'judge', 'sink', 'exporter']
  >();
});
