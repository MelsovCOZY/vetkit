import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';

const pkgDir = new URL('../', import.meta.url);
const read = (rel: string): string => readFileSync(new URL(rel, pkgDir), 'utf8');

describe('otlp schema is imported directly from the authored JSON', () => {
  test('tsconfig includes src json files and enables resolveJsonModule', () => {
    const tsconfig = read('tsconfig.json');
    expect(tsconfig).toContain('src/**/*.json');
    expect(tsconfig).toContain('resolveJsonModule');
  });

  test('the reader imports otlp.schema.json', () => {
    expect(read('src/reader/index.ts')).toMatch(/from '\.\/otlp\.schema\.json'/);
  });

  test('the TypeScript copy of the schema is gone', () => {
    expect(existsSync(new URL('src/reader/otlp.schema.ts', pkgDir))).toBe(false);
  });
});

describe('built dist still validates OTLP input', () => {
  const built = new URL('dist/index.js', pkgDir);

  test.skipIf(!existsSync(built))('rejects a non-OTLP document and accepts a minimal one', () => {
    const script = `
      const { readOtlpJson } = await import(${JSON.stringify(built.href)});
      const bad = readOtlpJson('{"nope":1}');
      const ok = readOtlpJson('{"resourceSpans":[]}');
      console.log(JSON.stringify({ bad: 'error' in bad, ok: 'error' in ok }));
    `;
    const out = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
    });
    expect(out.status).toBe(0);
    expect(out.stdout.trim()).toBe('{"bad":true,"ok":false}');
  });
});
