import { createHash } from 'node:crypto';
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

function collapse(value: string | undefined): string | undefined {
  return value?.replaceAll(/\s+/g, ' ').trim();
}

// Like the wording hash, but every whitespace run inside a field is one space, so an edit that only
// re-spaces a sentence hashes the same. Option order stays significant.
export function computeNormalizedWordingHash(fields: WordingFields): string {
  const { criteria } = fields;
  let collapsed: string[] | Record<string, string> | undefined;
  if (Array.isArray(criteria)) collapsed = criteria.map((item) => collapse(item) ?? '');
  else if (criteria !== undefined) {
    collapsed = Object.fromEntries(
      Object.entries(criteria).map(([key, text]) => [key, collapse(text) ?? '']),
    );
  }
  const subset = {
    type: fields.type,
    instructions: collapse(fields.instructions),
    criteria: collapsed,
    escape: collapse(fields.escape),
  };
  return createHash('sha256').update(JSON.stringify(subset)).digest('hex');
}
