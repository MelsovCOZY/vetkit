import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  formatLabelRow,
  LABEL_CSV_HEADER,
  loadLabels,
  parseCsv,
  parseLabels,
  type LabelRow,
} from './labels.ts';

const HEADER = 'case_id,criterion_id,label,labeler,labeled_at';

function csv(...rows: string[]): string {
  return `${[HEADER, ...rows].join('\n')}\n`;
}

async function tempDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vetkit-labels-'));
  await Promise.all(
    Object.entries(files).map(([name, content]) => writeFile(join(dir, name), content)),
  );
  return dir;
}

describe('parseCsv', () => {
  test('reads quoted commas, escaped quotes and CRLF line endings', () => {
    const records = parseCsv('a,b\r\n"x, y","say ""hi"""\r\n');
    expect(records.map((r) => r.fields)).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
    ]);
  });

  test('each record carries the 1-based line it starts on, across quoted newlines', () => {
    const records = parseCsv('a,b\n"multi\nline",c\nd,e\n');
    expect(records.map((r) => r.line)).toEqual([1, 2, 4]);
    expect(records[1]?.fields).toEqual(['multi\nline', 'c']);
  });
});

describe('parseLabels', () => {
  test('parses rows into LabelRow objects with the labeler name intact', () => {
    const text = csv(
      'case-1,tone,pass,"Doe, Jane",2026-09-28T10:00:00Z',
      'case-2,tone,fail,bob,2026-09-28T10:01:00Z',
    );
    const result = parseLabels(text, 'labels.csv');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0]).toEqual({
      caseId: 'case-1',
      criterionId: 'tone',
      label: 'pass',
      labeler: 'Doe, Jane',
      labeledAt: '2026-09-28T10:00:00Z',
    });
    expect(result.rows[1]?.label).toBe('fail');
  });

  test('keeps unknown labels as rows (counted, excluded from fitting later)', () => {
    const result = parseLabels(csv('case-1,tone,unknown,bob,2026-09-28'), 'labels.csv');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.label).toBe('unknown');
  });

  test('accepts CRLF files', () => {
    const text = `${HEADER}\r\ncase-1,tone,pass,bob,2026-09-28\r\n`;
    const result = parseLabels(text, 'labels.csv');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0]?.labeledAt).toBe('2026-09-28');
  });

  test('a label outside pass|fail|unknown is a LABELS_INVALID issue naming file and line', () => {
    const text = csv('case-1,tone,pass,bob,2026-09-28', 'case-2,tone,maybe,bob,2026-09-28');
    const result = parseLabels(text, 'labels.csv');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]).toMatchObject({ code: 'LABELS_INVALID', file: 'labels.csv', line: 3 });
  });

  test('a row with the wrong number of fields is a LABELS_INVALID issue', () => {
    const result = parseLabels(csv('case-1,tone,pass'), 'labels.csv');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]).toMatchObject({ code: 'LABELS_INVALID', line: 2 });
  });

  test('a header missing a required column is a LABELS_INVALID issue on line 1', () => {
    const result = parseLabels('case_id,label\ncase-1,pass\n', 'labels.csv');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]).toMatchObject({ code: 'LABELS_INVALID', line: 1 });
    expect(result.issues[0]?.message).toContain('criterion_id');
  });

  test('a case id not in the known set is a LABELS_INVALID issue naming the id', () => {
    const result = parseLabels(csv('ghost,tone,pass,bob,2026-09-28'), 'labels.csv', {
      caseIds: new Set(['case-1']),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]).toMatchObject({ code: 'LABELS_INVALID', line: 2 });
    expect(result.issues[0]?.message).toContain('ghost');
  });

  test('a criterion id not in the known set is a LABELS_INVALID issue naming the id', () => {
    const result = parseLabels(csv('case-1,nope,pass,bob,2026-09-28'), 'labels.csv', {
      caseIds: new Set(['case-1']),
      criterionIds: new Set(['tone']),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.message).toContain('nope');
  });

  test('a duplicate (case, criterion) row: last wins with a warning naming both lines', () => {
    const text = csv('case-1,tone,pass,bob,2026-09-28', 'case-1,tone,fail,bob,2026-09-29');
    const result = parseLabels(text, 'labels.csv');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.label).toBe('fail');
    expect(result.warnings[0]).toMatchObject({ file: 'labels.csv', line: 3 });
    expect(result.warnings[0]?.message).toContain('line 2');
  });
});

describe('formatLabelRow', () => {
  test('round-trips through parseLabels, quoting commas and quotes', () => {
    const row: LabelRow = {
      caseId: 'case-1',
      criterionId: 'tone',
      label: 'pass',
      labeler: 'Doe, "JJ" Jane',
      labeledAt: '2026-09-28T10:00:00Z',
    };
    const result = parseLabels(`${LABEL_CSV_HEADER}\n${formatLabelRow(row)}\n`, 'x.csv');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toEqual([row]);
  });
});

describe('loadLabels', () => {
  test('groups rows from every *.csv file into a LabelSet keyed by criterion id', async () => {
    const dir = await tempDir({
      'tone.csv': csv('case-1,tone,pass,bob,2026-09-28', 'case-2,tone,unknown,bob,2026-09-28'),
      'safety.csv': csv('case-1,safety,fail,bob,2026-09-28'),
      'notes.txt': 'ignored',
    });
    const result = await loadLabels(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.labels.get('tone')).toEqual([
      { caseId: 'case-1', label: 'pass', labeler: 'bob', labeledAt: '2026-09-28' },
      { caseId: 'case-2', label: 'unknown', labeler: 'bob', labeledAt: '2026-09-28' },
    ]);
    expect(result.labels.get('safety')?.[0]?.label).toBe('fail');
  });

  test('an unknown case id in any file fails the load with file and line', async () => {
    const dir = await tempDir({ 'tone.csv': csv('ghost,tone,pass,bob,2026-09-28') });
    const result = await loadLabels(dir, { caseIds: new Set(['case-1']) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]).toMatchObject({
      code: 'LABELS_INVALID',
      file: join(dir, 'tone.csv'),
      line: 2,
    });
  });
});
