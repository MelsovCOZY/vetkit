import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeParseJson } from '@vetkit/spec';
import { describe, expect, test } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path: string): string => readFileSync(join(repoRoot, path), 'utf8');

const j0 = read('docs/contracts/j0.md');
const coreConfig = read('packages/core/src/config.ts');

function cliEnginesNode(): string {
  const parsed = safeParseJson<{ engines: { node: string } }>(
    read('packages/cli/package.json'),
    {},
  );
  if (!parsed.ok) throw parsed.error;
  return parsed.value.engines.node;
}

// The J0 contract describes the repository as it is; a version or dependency it names that
// the manifests no longer carry sends a reader to code that does not exist.
describe('docs/contracts/j0.md matches the manifests', () => {
  test('neither core config.ts nor the contract mentions the removed c12 loader', () => {
    expect(coreConfig).not.toMatch(/\bc12\b/i);
    expect(j0).not.toMatch(/\bc12\b/i);
  });

  test("states the CLI's engines.node range and not the old >=22.12 floor", () => {
    expect(j0).toContain(cliEnginesNode());
    expect(j0).not.toContain('>=22.12');
  });

  test('refers to the pinned vitest version instead of a version literal', () => {
    expect(j0).not.toMatch(/vitest@\d+\.\d+\.\d+/);
    expect(j0).toContain('pinned vitest version');
  });
});

// The OTel LogRecord extension attributes shipped under the `vetkit.*` namespace; a contract that
// still names the pre-rename `classified_evals.*` prefix describes attributes no sink emits.
describe('docs/contracts/*.md use the vetkit OTel namespace', () => {
  test('no contract mentions classified_evals', () => {
    const dir = join(repoRoot, 'docs/contracts');
    const stale = readdirSync(dir)
      .filter((name) => name.endsWith('.md'))
      .filter((name) => read(join('docs/contracts', name)).includes('classified_evals'));
    expect(stale).toEqual([]);
  });
});
