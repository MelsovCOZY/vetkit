import { readFileSync } from 'node:fs';
import { safeParseJson } from '@vetkit/spec';
import { describe, expect, test } from 'vitest';
import { otlpSchema } from './otlp.schema.ts';

describe('otlp.schema.ts', () => {
  test('is identical to the authored otlp.schema.json', () => {
    const text = readFileSync(new URL('./otlp.schema.json', import.meta.url), 'utf8');
    const parsed = safeParseJson<unknown>(text, {});

    expect(parsed.ok).toBe(true);
    expect(otlpSchema).toEqual(parsed.ok ? parsed.value : undefined);
  });
});
