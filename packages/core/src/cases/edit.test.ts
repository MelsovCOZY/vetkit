// mol-p4a.1: dedupe/quarantine/review/promote helpers behind `vet cases`. Reuses J7's
// promoteFailure id/provenance shape for promoteVerdict (duplicated, not imported: promote.ts
// hardcodes its dayFile under <dir>/pending/, but this manual path targets <dir>/ directly —
// see promoteVerdict's own comment).
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safeParseJson, type Case, type Verdict } from '@vetkit/spec';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  dedupeKey,
  findDuplicates,
  listPendingCases,
  promoteVerdict,
  quarantineCase,
  removeCases,
  reviewCase,
} from './edit.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vet-cases-edit-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const NOW = new Date('2026-09-29T12:00:00.000Z');

function mkCase(id: string, state: string, overrides: Partial<Case> = {}): Case {
  return { id, input: { state }, provenance: null, tags: [], ...overrides };
}

function caseLine(c: Case | (Case & { readonly quarantine: unknown })): string {
  return JSON.stringify(c);
}

async function readLines(file: string): Promise<string[]> {
  return (await readFile(file, 'utf8')).split('\n').filter((l) => l !== '');
}

async function readCases(file: string): Promise<Case[]> {
  return (await readLines(file)).map((raw) => {
    const parsed = safeParseJson<Case>(raw, {});
    if (!parsed.ok) throw parsed.error;
    return parsed.value;
  });
}

async function writePending(root: string, name: string, cases: Case[]): Promise<void> {
  await mkdir(join(root, 'pending'), { recursive: true });
  await writeFile(join(root, 'pending', name), cases.map((c) => `${caseLine(c)}\n`).join(''));
}

function evalCase(overrides: Partial<Case> = {}): Case {
  return mkCase('case-orig', 'user: hi', { traceId: 'trace-abc', ...overrides });
}

function failingVerdict(overrides: Partial<Verdict> = {}): Verdict {
  return {
    id: 'case-orig:k-1',
    caseId: 'case-orig',
    criterionId: 'k-1',
    status: 'ok',
    pass: false,
    model: { requested: 'fake', resolved: 'fake-resolved', transport: 'fake', pinned: false },
    cacheHit: false,
    ...overrides,
  };
}

describe('dedupeKey', () => {
  test('is the same for state that only differs by leading/trailing whitespace', () => {
    expect(dedupeKey('hello world')).toBe(dedupeKey('  hello world  '));
  });

  test('differs for different state', () => {
    expect(dedupeKey('hello')).not.toBe(dedupeKey('goodbye'));
  });
});

describe('findDuplicates', () => {
  test('no duplicates: distinct state → []', () => {
    const cases = [mkCase('a', 'one'), mkCase('b', 'two')];
    expect(findDuplicates(cases)).toEqual([]);
  });

  test('0 cases → []', () => {
    expect(findDuplicates([])).toEqual([]);
  });

  test('a repeated normalised state reports the earliest id kept, the rest removed', () => {
    const cases = [
      mkCase('case-3', 'same state'),
      mkCase('case-1', ' same state '),
      mkCase('case-2', 'same state'),
    ];
    expect(findDuplicates(cases)).toEqual([
      { kept: 'case-1', removed: 'case-2' },
      { kept: 'case-1', removed: 'case-3' },
    ]);
  });
});

describe('removeCases', () => {
  test('removes only the named ids, rewriting the file atomically', async () => {
    const file = join(dir, 'a.jsonl');
    await writeFile(file, `${caseLine(mkCase('keep', 's1'))}\n${caseLine(mkCase('gone', 's2'))}\n`);

    await removeCases(dir, ['gone']);

    const cases = await readCases(file);
    expect(cases.map((c) => c.id)).toEqual(['keep']);
  });

  test('never touches quarantine.jsonl', async () => {
    const quarantineFile = join(dir, 'quarantine.jsonl');
    await writeFile(quarantineFile, `${caseLine(mkCase('q-1', 's'))}\n`);

    await removeCases(dir, ['q-1']);

    expect((await readCases(quarantineFile)).map((c) => c.id)).toEqual(['q-1']);
  });
});

describe('quarantineCase', () => {
  test('appends to quarantine.jsonl with reason+at, then removes it from its source file', async () => {
    const file = join(dir, 'a.jsonl');
    await writeFile(file, `${caseLine(mkCase('keep', 's1'))}\n${caseLine(mkCase('bad', 's2'))}\n`);

    const result = await quarantineCase(dir, 'bad', 'garbage output', NOW);

    expect(result).toEqual({ status: 'quarantined' });
    expect((await readCases(file)).map((c) => c.id)).toEqual(['keep']);
    const quarantined = await readCases(join(dir, 'quarantine.jsonl'));
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0]).toMatchObject({
      id: 'bad',
      quarantine: { reason: 'garbage output', at: '2026-09-29T12:00:00.000Z' },
    });
  });

  test('an already-quarantined id is a no-op: status already_quarantined, source untouched', async () => {
    const file = join(dir, 'a.jsonl');
    await writeFile(file, `${caseLine(mkCase('bad', 's2'))}\n`);
    await writeFile(
      join(dir, 'quarantine.jsonl'),
      `${caseLine({ ...mkCase('bad', 's2'), quarantine: { reason: 'r', at: NOW.toISOString() } })}\n`,
    );

    const result = await quarantineCase(dir, 'bad', 'second reason', NOW);

    expect(result).toEqual({ status: 'already_quarantined' });
    expect((await readCases(file)).map((c) => c.id)).toEqual(['bad']);
  });

  test('an id not found anywhere throws CASE_INVALID', async () => {
    await expect(quarantineCase(dir, 'missing', 'r', NOW)).rejects.toMatchObject({
      code: 'CASE_INVALID',
    });
  });
});

describe('listPendingCases and reviewCase', () => {
  test('listPendingCases reads every *.jsonl under <dir>/pending', async () => {
    await writePending(dir, 'promoted-2026-09-28.jsonl', [mkCase('p-1', 's1')]);

    const pending = await listPendingCases(dir);

    expect(pending.map((p) => p.case.id)).toEqual(['p-1']);
  });

  test('reviewCase accept moves the case into promoted-<today>.jsonl and out of pending', async () => {
    await writePending(dir, 'promoted-2026-09-28.jsonl', [mkCase('p-1', 's1')]);

    const moved = await reviewCase(dir, 'p-1', 'accept', { now: NOW });

    expect(moved).toBe(true);
    expect(await readCases(join(dir, 'promoted-2026-09-29.jsonl'))).toEqual([mkCase('p-1', 's1')]);
    expect(await listPendingCases(dir)).toEqual([]);
  });

  test('reviewCase reject moves the case into quarantine.jsonl with the reason', async () => {
    await writePending(dir, 'promoted-2026-09-28.jsonl', [mkCase('p-2', 's2')]);

    const moved = await reviewCase(dir, 'p-2', 'reject', { reason: 'bad trace', now: NOW });

    expect(moved).toBe(true);
    const quarantined = await readCases(join(dir, 'quarantine.jsonl'));
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0]).toMatchObject({
      id: 'p-2',
      quarantine: { reason: 'bad trace', at: '2026-09-29T12:00:00.000Z' },
    });
    expect(await listPendingCases(dir)).toEqual([]);
  });

  test('reviewCase returns false when the id is not pending', async () => {
    expect(await reviewCase(dir, 'nope', 'accept', { now: NOW })).toBe(false);
  });
});

describe('promoteVerdict', () => {
  test('appends one PromotedCase to <dir>/promoted-<date>.jsonl with provenance.promotedFrom.verdictId', async () => {
    const promoted = await promoteVerdict(dir, failingVerdict(), evalCase(), NOW);

    expect(promoted).toMatchObject({
      id: 'promoted-trace-abc-k-1',
      provenance: {
        promotedFrom: {
          traceId: 'trace-abc',
          criterionId: 'k-1',
          verdictId: 'case-orig:k-1',
          at: '2026-09-29T12:00:00.000Z',
        },
      },
    });
    const written = await readCases(join(dir, 'promoted-2026-09-29.jsonl'));
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ id: 'promoted-trace-abc-k-1' });
  });

  test("dh8.7: keeps the case's existing provenance fields (traceId, spanId, traceIds) alongside promotedFrom", async () => {
    const withProvenance = evalCase({
      provenance: { traceId: 'trace-abc', spanId: 'span-1', traceIds: ['trace-abc'] },
    });
    const promoted = await promoteVerdict(dir, failingVerdict(), withProvenance, NOW);

    expect(promoted).toMatchObject({
      provenance: {
        traceId: 'trace-abc',
        spanId: 'span-1',
        traceIds: ['trace-abc'],
        promotedFrom: { traceId: 'trace-abc', criterionId: 'k-1', verdictId: 'case-orig:k-1' },
      },
    });
  });

  test('a passing verdict is never promoted', async () => {
    const promoted = await promoteVerdict(dir, failingVerdict({ pass: true }), evalCase(), NOW);
    expect(promoted).toBeUndefined();
  });

  test('a case with no traceId is never promoted', async () => {
    const promoted = await promoteVerdict(
      dir,
      failingVerdict(),
      mkCase('case-orig', 'user: hi'),
      NOW,
    );
    expect(promoted).toBeUndefined();
  });

  test('a verdict with no id is never promoted', async () => {
    const { id: _id, ...noId } = failingVerdict();
    const promoted = await promoteVerdict(dir, noId, evalCase(), NOW);
    expect(promoted).toBeUndefined();
  });
});
