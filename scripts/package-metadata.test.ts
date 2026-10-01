import { expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES_DIR = join(ROOT, 'packages');

interface Manifest {
  license?: string;
  description?: string;
  keywords?: string[];
  homepage?: string;
  repository?: { type?: string; url?: string; directory?: string };
  bugs?: { url?: string };
  types?: string;
}

const packageNames = existsSync(PACKAGES_DIR)
  ? readdirSync(PACKAGES_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .toSorted()
  : [];

const TAGLINE =
  'LLM evals from your production traces: generated, judged by cheap typed decisions, calibrated and gated in CI';
const SHARED_KEYWORDS = ['llm', 'evals', 'evaluation', 'typescript', 'ci'];
// Only the CLI and the Jev adapter are about Jev; the judge name on every sibling would let a
// search for it land on a package that cannot be installed on its own.
const JEV_KEYWORD_PACKAGES = ['cli', 'judge-jev'];

function load(dir: string): Manifest {
  return JSON.parse(readFileSync(join(PACKAGES_DIR, dir, 'package.json'), 'utf8'));
}

it('discovers the 12 packages', () => {
  expect(packageNames).toHaveLength(12);
});

it('packages/cli description is the project tagline', () => {
  expect(load('cli').description).toBe(TAGLINE);
});

it.each(packageNames)('%s declares license Apache-2.0', (dir) => {
  expect(load(dir).license).toBe('Apache-2.0');
});

it.each(packageNames)('%s has a one-line description of at most 120 characters', (dir) => {
  const { description } = load(dir);
  expect(description).toBeTypeOf('string');
  expect(description?.length).toBeGreaterThan(0);
  expect(description?.length).toBeLessThanOrEqual(120);
  expect(description).not.toMatch(/[\r\n]/);
});

it.each(packageNames)('%s lists the five shared keywords', (dir) => {
  const { keywords } = load(dir);
  expect(keywords?.length).toBeGreaterThanOrEqual(5);
  expect(keywords).toEqual(expect.arrayContaining(SHARED_KEYWORDS));
});

it.each(packageNames)(
  '%s has the jev keyword only when it is the CLI or the Jev adapter',
  (dir) => {
    expect(load(dir).keywords?.includes('jev')).toBe(JEV_KEYWORD_PACKAGES.includes(dir));
  },
);

it.each(packageNames)('%s homepage is the Pages URL', (dir) => {
  expect(load(dir).homepage).toBe('https://melsovcozy.github.io/vetkit/');
});

it.each(packageNames)('%s repository is the exact GitHub URL with its own directory', (dir) => {
  expect(load(dir).repository).toEqual({
    type: 'git',
    url: 'git+https://github.com/MelsovCOZY/vetkit.git',
    directory: `packages/${dir}`,
  });
});

it.each(packageNames)('%s bugs points at the issue tracker', (dir) => {
  expect(load(dir).bugs).toEqual({ url: 'https://github.com/MelsovCOZY/vetkit/issues' });
});

it.each(packageNames)('%s types points at ./dist/index.d.ts', (dir) => {
  expect(load(dir).types).toBe('./dist/index.d.ts');
});
