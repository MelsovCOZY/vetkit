import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = readFileSync(join(ROOT, 'docs/configuration.md'), 'utf8');

// Identifiers with the CEV_ prefix that are not environment variables.
const NOT_ENV = new Set(['CEV_ERROR_CODES', 'CEV_EXIT']);

function sourceFiles(pkg: string): string[] {
  const dir = join(ROOT, 'packages', pkg, 'src');
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((path) => path.endsWith('.ts'))
    .filter((path) => !/\.test(-d)?\.ts$/.test(path) && !path.split('/').includes('test-support'))
    .map((path) => join(dir, path));
}

function readVariables(): Set<string> {
  const names = new Set<string>();
  for (const file of [...sourceFiles('cli'), ...sourceFiles('core')]) {
    for (const match of readFileSync(file, 'utf8').matchAll(/\bCEV_[A-Z_]+\b/g)) {
      if (!NOT_ENV.has(match[0])) names.add(match[0]);
    }
  }
  return names;
}

function documentedVariables(): Set<string> {
  return new Set([...DOCS.matchAll(/`(CEV_[A-Z_]+)`/g)].map((m) => m[1] ?? ''));
}

describe('docs/configuration.md environment variables', () => {
  it('every CEV_* variable read in cli/core sources is documented', () => {
    const documented = documentedVariables();
    const missing = [...readVariables()].filter((name) => !documented.has(name));
    expect(missing).toEqual([]);
  });

  it('every documented CEV_* variable is read somewhere', () => {
    const read = readVariables();
    const stale = [...documentedVariables()].filter((name) => !read.has(name));
    expect(stale).toEqual([]);
  });

  it('the judge credential table still matches ENV_VARS', () => {
    // ENV_VARS (packages/cli/src/commands/doctor.ts) derives from the JEV presets; scripts/ may
    // not import the cli package, so the five credential names are spelled out here.
    for (const name of [
      'AI_GATEWAY_API_KEY',
      'OPENROUTER_API_KEY',
      'CLOUDFLARE_API_TOKEN',
      'CLOUDFLARE_ACCOUNT_ID',
      'TYPESAFE_API_KEY',
    ]) {
      expect(DOCS).toContain(`\`${name}\``);
    }
  });

  it('states the CEV_ prefix is legacy', () => {
    expect(DOCS).toMatch(/CEV_ prefix is legacy/);
  });
});
