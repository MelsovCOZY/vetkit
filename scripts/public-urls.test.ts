import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LINT_RULES } from '@vetkit/core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGES = 'https://melsovcozy.github.io/vetkit';
// The old host is a domain the project does not own. It is built from parts so this file does not
// contain it.
const OLD_HOST = ['vetkit', 'dev'].join('.');

const schemaDir = join(ROOT, 'packages/spec/schemas');
const specSchemaFiles = readdirSync(schemaDir)
  .filter((name) => name.endsWith('.schema.json'))
  .toSorted();

const readId = (path: string): string => {
  const schema: { $id?: string } = JSON.parse(readFileSync(path, 'utf8'));
  return schema.$id ?? '';
};

function trackedTextFiles(): { path: string; text: string }[] {
  const listed = execFileSync('git', ['ls-files', '-z', 'packages', 'scripts', 'docs'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return listed
    .split('\0')
    .filter((path) => path !== '')
    .flatMap((path) => {
      try {
        const text = readFileSync(join(ROOT, path), 'utf8');
        return text.includes('\0') ? [] : [{ path, text }];
      } catch {
        return [];
      }
    });
}

describe('public URLs point at the Pages site', () => {
  it('no tracked file under packages, scripts or docs mentions the old host', () => {
    const files = trackedTextFiles();
    expect(files.length).toBeGreaterThan(100);
    const hits = files.filter((file) => file.text.includes(OLD_HOST)).map((file) => file.path);
    expect(hits).toEqual([]);
  });

  it.each(specSchemaFiles)('%s $id is the Pages URL of its file name', (name) => {
    expect(readId(join(schemaDir, name))).toBe(`${PAGES}/schemas/${name}`);
  });

  it('the otlp reader schema $id is under schemas/source-otlp/', () => {
    expect(readId(join(ROOT, 'packages/source-otlp/src/reader/otlp.schema.json'))).toBe(
      `${PAGES}/schemas/source-otlp/otlp.schema.json`,
    );
  });

  it('the source-jsonl inline ids are under schemas/source-jsonl/', () => {
    const text = readFileSync(join(ROOT, 'packages/source-jsonl/src/jsonl.ts'), 'utf8');
    expect(text).toContain(`$id: '${PAGES}/schemas/source-jsonl/own-line.schema.json'`);
    expect(text).toContain(`$id: '${PAGES}/schemas/source-jsonl/openai-line.schema.json'`);
  });

  it('LINT_RULES docs links start with the Pages lint page', () => {
    expect(LINT_RULES.length).toBeGreaterThan(0);
    for (const entry of LINT_RULES) {
      const anchor = entry.id.toLowerCase().replaceAll('_', '-');
      expect(entry.docs).toBe(`${PAGES}/docs/lint.html#${anchor}`);
    }
  });
});
