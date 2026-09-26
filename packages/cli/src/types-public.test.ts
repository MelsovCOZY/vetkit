import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, test } from 'vitest';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const srcDir = fileURLToPath(new URL('.', import.meta.url));
const distDir = fileURLToPath(new URL('../dist', import.meta.url));

// Mirrors program.test.ts's ensureBinBuilt: build packages/cli here, before reading
// dist/, only when dist is absent or older than the newest file under src/.
function newestMtimeMs(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryPath = `${dir}/${entry.name}`;
    newest = Math.max(
      newest,
      entry.isDirectory() ? newestMtimeMs(entryPath) : statSync(entryPath).mtimeMs,
    );
  }
  return newest;
}

function isDistStale(): boolean {
  if (!existsSync(distDir)) return true;
  return newestMtimeMs(srcDir) > newestMtimeMs(distDir);
}

function ensureDistBuilt(): void {
  if (!isDistStale()) return;
  const result = spawnSync('bun', ['x', 'tsdown'], { cwd: packageRoot, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`tsdown build failed for packages/cli:\n${result.stdout}\n${result.stderr}`);
  }
}

beforeAll(() => {
  ensureDistBuilt();
}, 60_000);

function findDeclarationFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryPath = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...findDeclarationFiles(entryPath));
    } else if (entry.name.endsWith('.d.ts')) {
      files.push(entryPath);
    }
  }
  return files;
}

describe('built cli declarations', () => {
  test('contain no NodeJS namespace reference', () => {
    const declarationFiles = findDeclarationFiles(distDir);
    expect(declarationFiles.length).toBeGreaterThan(0);
    const offenders = declarationFiles.filter((file) =>
      readFileSync(file, 'utf8').includes('NodeJS.'),
    );
    expect(offenders).toEqual([]);
  });
});
