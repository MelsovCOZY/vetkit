import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const EXAMPLES = new URL('../../../examples/', import.meta.url);
const read = (relative: string): string => readFileSync(new URL(relative, EXAMPLES), 'utf8');
const exists = (relative: string): boolean => existsSync(new URL(relative, EXAMPLES));

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

  test('scripts.test runs tsc --noEmit before vitest run; vitest declared as the peer range and typecheck strict', () => {
    const pkg = read('vitest/package.json');
    expect(pkg).toMatch(/"private":\s*true/);
    expect(pkg).toContain('"test": "tsc --noEmit -p tsconfig.json && vitest run"');
    // The example declares the range this package accepts as its optional vitest peer, so a
    // plain install resolves the newest matching release, not one exact version.
    const peerRange = /"peerDependencies":\s*\{\s*"vitest":\s*"(\^[^"]+)"/.exec(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    )?.[1];
    expect(peerRange).toBeDefined();
    expect(pkg).toContain(`"vitest": "${peerRange ?? ''}"`);
    expect(pkg).toContain('"@vetkit/scorers"');
    expect(pkg).toMatch(/"typescript":\s*"\d+\.\d+\.\d+"/);
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
    const pkg = read('promptfoo/package.json');
    expect(pkg).toMatch(/"private":\s*true/);
    expect(pkg).toContain('"test": "promptfoo eval --no-cache -c promptfooconfig.yaml"');
    expect(pkg).toMatch(/"promptfoo":\s*"0\.123\.1"/);
    expect(pkg).toContain('"@vetkit/scorers"');
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
