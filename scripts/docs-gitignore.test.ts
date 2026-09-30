import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function isIgnored(path: string): boolean {
  const result = spawnSync('git', ['check-ignore', '-q', '--no-index', path], { cwd: ROOT });
  return result.status === 0;
}

describe('docs/ ignore allowlist', () => {
  it.each([
    ['docs', 'research/2026-01-01-brief.md'].join('/'),
    ['docs', 'INDEX.md'].join('/'),
    'docs/notes.md',
    'docs/drafts/plan.md',
  ])('ignores %s', (path) => {
    expect(isIgnored(path)).toBe(true);
  });

  it.each([
    'docs/.gitkeep',
    'docs/configuration.md',
    'docs/sinks.md',
    'docs/watch.md',
    'docs/contracts/j3.md',
    'docs/contracts/new-contract.md',
    'docs/guides/x.md',
    'docs/guides/otlp-http-json.md',
  ])('keeps %s', (path) => {
    expect(isIgnored(path)).toBe(false);
  });

  it('tracks only the kept files under docs/', () => {
    const listed = execFileSync('git', ['ls-files', 'docs'], { cwd: ROOT, encoding: 'utf8' });
    const outside = listed
      .split('\n')
      .filter((path) => path !== '')
      .filter(
        (path) =>
          !/^docs\/(\.gitkeep|configuration\.md|sinks\.md|watch\.md|contracts\/.+|guides\/.+)$/.test(
            path,
          ),
      );
    expect(outside).toEqual([]);
  });
});
