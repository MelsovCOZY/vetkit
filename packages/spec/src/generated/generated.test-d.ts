import { expectTypeOf, test } from 'vitest';
import type { SpecVersionDoc } from './index.ts';

test('SpecVersionDoc.specVersion is the literal type "v1"', () => {
  expectTypeOf<SpecVersionDoc['specVersion']>().toEqualTypeOf<'v1'>();
});
