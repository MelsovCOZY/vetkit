import type { SourceV1 } from '@vetkit/spec';
import { expectTypeOf, test } from 'vitest';
import { otlpSource } from './index.ts';
import type { DialectV1, OtlpDiag } from './index.ts';

test('otlpSource opts is {files?, dialects?, onDiag?} and it returns a SourceV1', () => {
  expectTypeOf(otlpSource).parameter(0).toEqualTypeOf<{
    files?: string[];
    dialects?: readonly DialectV1[];
    onDiag?: (d: OtlpDiag) => void;
  }>();
  expectTypeOf(otlpSource).returns.toEqualTypeOf<SourceV1>();
});
