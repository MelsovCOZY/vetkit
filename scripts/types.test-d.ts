import { expectTypeOf, test } from 'vitest';

test('expectTypeOf<1>() equals its own type', () => {
  expectTypeOf<1>().toEqualTypeOf<1>();
});
