import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const EXAMPLES = new URL('../../../examples/', import.meta.url);
const read = (relative: string): string => readFileSync(new URL(relative, EXAMPLES), 'utf8');
const exists = (relative: string): boolean => existsSync(new URL(relative, EXAMPLES));

interface ExamplePackage {
  private?: boolean;
  scripts: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

describe('examples/vitest', () => {
  test('has the documented deliverables', () => {
    for (const file of [
      'vitest/vitest.config.ts',
      'vitest/vetkit.setup.ts',
      'vitest/evals/criteria.yaml',
      'vitest/refund.eval.test.ts',
      'vitest/vetkit.config.ts',
      'vitest/tsconfig.json',
      'vitest/README.md',
      'vitest/.env.example',
    ]) {
      expect(exists(file), file).toBe(true);
    }
    expect(exists('vitest/evals/cases/seed.jsonl')).toBe(true);
  });

  test('scripts.test runs tsc --noEmit before vitest run; vitest pinned exactly and typecheck strict', () => {
    const pkg: ExamplePackage = JSON.parse(read('vitest/package.json'));
    expect(pkg.private).toBe(true);
    expect(pkg.scripts['test']).toBe('tsc --noEmit -p tsconfig.json && vitest run');
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(deps['vitest']).toBe('5.0.2');
    expect(deps['@vetkit/scorers']).toBeDefined();
    expect(deps['typescript']).toMatch(/^\d+\.\d+\.\d+/);
    const tsconfig = read('vitest/tsconfig.json');
    expect(tsconfig).toMatch(/"strict":\s*true/);
    expect(tsconfig).toMatch(/"skipLibCheck":\s*false/);
  });

  test('setup imports the subpath and the eval test uses toPassCriterion with no any casts', () => {
    const setup = read('vitest/vetkit.setup.ts');
    expect(setup).toContain("from '@vetkit/scorers/vitest'");
    expect(setup).toContain('expect.extend');
    const evalTest = read('vitest/refund.eval.test.ts');
    expect(evalTest).toContain('toPassCriterion');
    expect(evalTest).toContain('loadCases');
    for (const file of ['vitest/vetkit.setup.ts', 'vitest/refund.eval.test.ts']) {
      const text = read(file);
      expect(text, file).not.toMatch(/\bas any\b|:\s*any\b|declare module/);
    }
  });
});

describe('examples/promptfoo', () => {
  test('has the documented deliverables', () => {
    for (const file of [
      'promptfoo/promptfooconfig.yaml',
      'promptfoo/vetkit.assert.ts',
      'promptfoo/judge.ts',
      'promptfoo/evals/criteria.yaml',
      'promptfoo/README.md',
      'promptfoo/.env.example',
    ]) {
      expect(exists(file), file).toBe(true);
    }
  });

  test('scripts.test runs promptfoo eval with a pinned promptfoo', () => {
    const pkg: ExamplePackage = JSON.parse(read('promptfoo/package.json'));
    expect(pkg.private).toBe(true);
    expect(pkg.scripts['test']).toBe('promptfoo eval --no-cache -c promptfooconfig.yaml');
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(deps['promptfoo']).toBe('0.123.1');
    expect(deps['@vetkit/scorers']).toBeDefined();
  });

  test('config asserts through vetkit.assert.ts and the assertion reads no key value', () => {
    const config = read('promptfoo/promptfooconfig.yaml');
    expect(config).toContain('type: javascript');
    expect(config).toContain('file://vetkit.assert.ts');
    expect(config).toMatch(/input:/);
    const assertion = read('promptfoo/vetkit.assert.ts');
    expect(assertion).toContain('toPromptfooAssertion');
    expect(assertion).toContain('readLockOrNull');
    expect(assertion).toContain('loadCriteria');
    const judge = read('promptfoo/judge.ts');
    expect(judge).toContain('demoJudge');
    expect(judge).toContain('OPENROUTER_API_KEY');
    expect(judge).not.toMatch(/sk-[A-Za-z0-9_-]{16,}/);
  });
});
