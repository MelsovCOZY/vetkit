// Asserts the exact shapes fixed by docs/contracts/j7.md "Ports and types" (bead
// classified-evals-mol-zde, admin repair: zde owns types.ts + this test).
import { expectTypeOf, test } from 'vitest';
import type { Case } from '@vetkit/spec';
import type { InclusionRecord, PromotedCase, WatchOptions } from './types.ts';

test('WatchOptions has the exact fields and defaults documented in j7.md', () => {
  expectTypeOf<WatchOptions['sampleRate']>().toEqualTypeOf<number>();
  expectTypeOf<WatchOptions['upstreamSampleRate']>().toEqualTypeOf<number | undefined>();
  expectTypeOf<WatchOptions['maxInFlight']>().toEqualTypeOf<number>();
  expectTypeOf<WatchOptions['promoteOn']>().toEqualTypeOf<'fail' | 'never'>();
  expectTypeOf<WatchOptions['inclusionPath']>().toEqualTypeOf<string>();
  expectTypeOf<WatchOptions['promotedDir']>().toEqualTypeOf<string>();
});

test('InclusionRecord has the exact fields and literal unions documented in j7.md', () => {
  expectTypeOf<InclusionRecord['traceId']>().toEqualTypeOf<string>();
  expectTypeOf<InclusionRecord['at']>().toEqualTypeOf<string>();
  expectTypeOf<InclusionRecord['sampled']>().toEqualTypeOf<boolean>();
  expectTypeOf<InclusionRecord['reason']>().toEqualTypeOf<
    'rate' | 'filtered:incomplete' | 'filtered:no_content'
  >();
  expectTypeOf<InclusionRecord['evaluatorRate']>().toEqualTypeOf<number>();
  expectTypeOf<InclusionRecord['upstreamRate']>().toEqualTypeOf<number | 'unknown'>();
  expectTypeOf<InclusionRecord['inclusionProbability']>().toEqualTypeOf<number | 'unknown'>();
});

test('PromotedCase extends Case; provenance reduces to {promotedFrom} since Case["provenance"] is unknown (j7.md Premise)', () => {
  expectTypeOf<PromotedCase>().toExtend<Case>();
  expectTypeOf<PromotedCase['provenance']>().toEqualTypeOf<{
    promotedFrom: { traceId: string; criterionId: string; verdictId: string; at: string };
  }>();
});
