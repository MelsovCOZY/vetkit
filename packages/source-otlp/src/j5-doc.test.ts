import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

describe('source contract doc', () => {
  test('does not claim the spec index lacks defineAdapter', () => {
    const doc = readFileSync(new URL('../../../docs/contracts/j5.md', import.meta.url), 'utf8');
    expect(doc.replaceAll(/\s+/g, ' ')).not.toContain('no `defineAdapter`');
  });
});
