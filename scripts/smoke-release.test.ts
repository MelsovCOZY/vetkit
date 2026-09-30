import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(repoRoot, 'scripts', 'smoke-release.sh'), 'utf8');

// The scratch root (and every log in it) is removed on exit unless VETKIT_SMOKE_DIR chose it,
// so a bare FAILED verdict leaves the reader with nothing to inspect and no way to know why.
describe('scripts/smoke-release.sh FAILED verdict', () => {
  test('says how to keep the logs when the scratch root is about to be removed', () => {
    expect(src).toContain('set VETKIT_SMOKE_DIR=<dir> to keep the logs');
  });

  test('says where the logs are when VETKIT_SMOKE_DIR kept them', () => {
    expect(src).toContain('logs kept at $WORK');
  });

  test('never prints a bare FAILED line', () => {
    expect(src).not.toMatch(/say "FAILED"/);
  });
});
