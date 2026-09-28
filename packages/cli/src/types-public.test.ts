import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, test } from 'vitest';
import { ensureCliBuilt } from './test-support/build-cli.js';

const distDir = fileURLToPath(new URL('../dist', import.meta.url));

// Shares a single packages/cli build with program.test.ts's beforeAll (via
// ensureCliBuilt's lock) instead of each test file racing its own `bun x tsdown`
// against the same dist/ directory in parallel vitest workers.
beforeAll(async () => {
  await ensureCliBuilt();
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

  test('export judgeOne from the package entry', () => {
    const entry = readFileSync(`${distDir}/index.d.ts`, 'utf8');
    expect(entry).toMatch(/\bjudgeOne\b/);
  });

  test('export decideVerdict from the package entry', () => {
    const entry = readFileSync(`${distDir}/index.d.ts`, 'utf8');
    expect(entry).toMatch(/\bdecideVerdict\b/);
  });
});
