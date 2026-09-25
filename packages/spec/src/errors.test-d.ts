import { expectTypeOf, test } from 'vitest';
import { CEV_ERROR_CODES, type CevErrorCode } from './errors.ts';

test('CevErrorCode equals the union of CEV_ERROR_CODES values', () => {
  expectTypeOf<CevErrorCode>().toEqualTypeOf<
    (typeof CEV_ERROR_CODES)[keyof typeof CEV_ERROR_CODES]
  >();
});
