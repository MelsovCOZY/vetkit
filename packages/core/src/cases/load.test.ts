import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { loadCases } from './load.ts';

const fixtures = fileURLToPath(new URL('../../../../fixtures/criteria/cases/', import.meta.url));
const fixture = (name: string): string => join(fixtures, name);

async function tempDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vetkit-cases-'));
  await Promise.all(
    Object.entries(files).map(([name, content]) => writeFile(join(dir, name), content)),
  );
  return dir;
}

function caseLine(id: string, state: string): string {
  return JSON.stringify({ id, input: { state }, provenance: null, tags: [] });
}

describe('loadCases', () => {
  test('reads every *.jsonl line into Case[], skipping blank lines and non-jsonl files', async () => {
    const result = await loadCases(fixture('valid'));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cases.map((c) => c.id)).toEqual(['case-1', 'case-2']);
    expect(result.cases[1]).toMatchObject({
      input: { state: 'User: 2+2?', answer: '4' },
      expected: { value: '4', source: 'user' },
      language: 'en',
    });
  });

  test('an invalid line is a CASE_INVALID issue carrying its file and line number', async () => {
    const result = await loadCases(fixture('bad-line'));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: 'CASE_INVALID',
        file: join(fixture('bad-line'), 'bad-line.jsonl'),
        line: 2,
        message: expect.any(String),
      }),
    );
    expect(result.issues.every((i) => i.line === 2)).toBe(true);
  });

  test('a line that is not JSON is a CASE_INVALID issue with its line number', async () => {
    const dir = await tempDir({ 'a.jsonl': `${caseLine('x', 's')}\n{nope\n` });

    const result = await loadCases(dir);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]).toMatchObject({ code: 'CASE_INVALID', line: 2 });
  });

  test('duplicate case ids across files are a CASE_INVALID issue naming both locations', async () => {
    const dir = fixture('duplicate');

    const result = await loadCases(dir);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: 'CASE_INVALID',
        file: join(dir, 'b.jsonl'),
        line: 2,
        related: { file: join(dir, 'a.jsonl'), line: 1 },
        message: expect.stringContaining('case-1'),
      }),
    );
  });

  test('CRLF line endings load the same cases', async () => {
    const dir = await tempDir({
      'a.jsonl': `${caseLine('a', 's')}\r\n\r\n${caseLine('b', 't')}\r\n`,
    });

    const result = await loadCases(dir);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cases.map((c) => c.id)).toEqual(['a', 'b']);
  });

  test('a state over 32k tokens (chars/4) is an INPUT_TOO_LARGE issue at load time', async () => {
    const dir = await tempDir({ 'a.jsonl': `${caseLine('big', 'x'.repeat(32_000 * 4 + 4))}\n` });

    const result = await loadCases(dir);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'INPUT_TOO_LARGE', file: join(dir, 'a.jsonl'), line: 1 }),
    );
  });

  test('a state at exactly 32k tokens loads', async () => {
    const dir = await tempDir({ 'a.jsonl': `${caseLine('edge', 'x'.repeat(32_000 * 4))}\n` });

    const result = await loadCases(dir);

    expect(result.ok).toBe(true);
  });

  test('a missing directory returns an issue instead of throwing', async () => {
    const result = await loadCases(fixture('does-not-exist'));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]).toMatchObject({ code: 'E_IO' });
  });

  test('quarantine.jsonl is excluded from the default load (vet cases quarantine, vet run)', async () => {
    const dir = await tempDir({
      'a.jsonl': `${caseLine('kept', 's')}\n`,
      'quarantine.jsonl': `${caseLine('quarantined', 't')}\n`,
    });

    const result = await loadCases(dir);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cases.map((c) => c.id)).toEqual(['kept']);
  });
});
