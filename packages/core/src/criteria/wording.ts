import type { Criterion } from '@vetkit/spec';
import type { WordingFields } from './load.ts';

// Optional keys are spread in only when present: exactOptionalPropertyTypes rejects an
// explicit `undefined`, and JSON.stringify in the hash drops absent keys anyway.
export function wordingOf(c: Criterion): WordingFields {
  return {
    type: c.type,
    instructions: c.instructions,
    ...(c.criteria === undefined ? {} : { criteria: c.criteria }),
    ...(c.escape === undefined ? {} : { escape: c.escape }),
  };
}
