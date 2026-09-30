import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8');

describe('@vetkit/scorers/vitest subpath', () => {
  test('the root entry declares no vitest augmentation', () => {
    const sources = readdirSync(new URL('.', import.meta.url)).filter(
      (file) => file.endsWith('.ts') && !/\.test(-d)?\.ts$/.test(file) && file !== 'vitest.ts',
    );
    for (const file of sources) {
      const text = read(file);
      expect(text, file).not.toMatch(/declare module ['"]vitest['"]/);
      expect(text, file).not.toMatch(/from ['"]\.\/vitest(\.ts)?['"]/);
      expect(text, file).not.toMatch(/from ['"]vitest['"]/);
    }
  });

  test('vitest.ts augments Assertion and re-exports vetMatchers', () => {
    const text = read('vitest.ts');
    expect(text).toMatch(/declare module ['"]vitest['"]/);
    expect(text).toContain('toPassCriterion');
    expect(text).toMatch(/export \{ vetMatchers \}/);
  });

  test('package.json exports ./vitest with types and import and keeps vitest an optional peer', () => {
    const pkg: {
      exports: Record<string, { types: string; import: string }>;
      dependencies: Record<string, string>;
      peerDependenciesMeta: Record<string, { optional: boolean }>;
    } = JSON.parse(read('../package.json'));
    expect(pkg.exports['./vitest']).toEqual({
      types: './dist/vitest.d.ts',
      import: './dist/vitest.js',
    });
    expect(pkg.dependencies).not.toHaveProperty('vitest');
    expect(pkg.peerDependenciesMeta['vitest']?.optional).toBe(true);
  });

  test('tsdown builds both entries', () => {
    const text = read('../tsdown.config.ts');
    expect(text).toContain("'src/index.ts'");
    expect(text).toContain("'src/vitest.ts'");
  });
});
