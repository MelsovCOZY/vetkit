import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES_DIR = join(ROOT, 'packages');

const packageNames = existsSync(PACKAGES_DIR)
  ? readdirSync(PACKAGES_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .toSorted()
  : [];

function readRoot(): Buffer {
  return readFileSync(join(ROOT, 'LICENSE'));
}

describe('LICENSE', () => {
  it('root LICENSE is the Apache-2.0 text', () => {
    const text = readRoot().toString('utf8');
    expect(text).toContain('Apache License');
    expect(text).toContain('Version 2.0, January 2004');
    expect(text).toContain('http://www.apache.org/licenses/');
  });

  it.each(packageNames)('packages/%s/LICENSE is byte-identical to the root LICENSE', (dir) => {
    const copy = readFileSync(join(PACKAGES_DIR, dir, 'LICENSE'));
    expect(copy.equals(readRoot())).toBe(true);
  });

  it('a packed package lists package/LICENSE', () => {
    const tarballDir = mkdtempSync(join(tmpdir(), 'vetkit-license-'));
    try {
      const packOut = spawnSync('bun', ['pm', 'pack', '--quiet', '--destination', tarballDir], {
        cwd: join(PACKAGES_DIR, 'spec'),
        encoding: 'utf8',
      });
      expect(packOut.status).toBe(0);
      const listing = spawnSync('tar', ['-tzf', packOut.stdout.trim()], { encoding: 'utf8' });
      expect(listing.stdout.split('\n')).toContain('package/LICENSE');
    } finally {
      rmSync(tarballDir, { recursive: true, force: true });
    }
  });
});
