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

  test('vitest.ts augments expect(x) with toPassCriterion and re-exports vetMatchers', () => {
    const text = read('vitest.ts');
    expect(text).toMatch(/declare module ['"]vitest['"]/);
    expect(text).toContain('toPassCriterion');
    expect(text).toMatch(/export \{ vetMatchers \}/);
  });

  test('package.json exports ./vitest with types and import and keeps vitest an optional peer', () => {
    const pkg = read('../package.json');
    expect(pkg).toMatch(
      /"\.\/vitest":\s*\{\s*"types":\s*"\.\/dist\/vitest\.d\.ts",\s*"import":\s*"\.\/dist\/vitest\.js"\s*\}/,
    );
    const [, dependencies = ''] = /"dependencies":\s*\{([^}]*)\}/.exec(pkg) ?? [];
    expect(dependencies).not.toContain('vitest');
    expect(pkg).toMatch(/"peerDependenciesMeta":\s*\{\s*"vitest":\s*\{\s*"optional":\s*true/);
  });

  test('tsdown builds both entries', () => {
    const text = read('../tsdown.config.ts');
    expect(text).toContain("'src/index.ts'");
    expect(text).toContain("'src/vitest.ts'");
  });
});
