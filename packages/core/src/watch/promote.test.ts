// docs/contracts/j7.md "Promotion"; bead classified-evals-mol-dh8.3.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safeParseJson, type Case, type Verdict } from '@vetkit/spec';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { loadCases } from '../cases/load.ts';
import { promoteFailure } from './promote.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vet-promote-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const NOW = new Date('2026-09-29T12:00:00.000Z');

function evalCase(overrides: Partial<Case> = {}): Case {
  return {
    id: 'case-orig',
    input: { state: 'user: hi\nassistant: hello' },
    traceId: 'trace-abc',
    provenance: { traceIds: ['trace-abc'] },
    tags: [],
    ...overrides,
  };
}

// dh8.5: the real onVerdict call site now always hands promoteFailure a verdict whose `id`
// is exactly what outbox.enqueue assigned it — so every fixture here has a real id, same as
// production, rather than relying on a synthesized fallback (dh8.3's earlier randomUUID
// stand-in, dropped now that the real id is always available).
function failingVerdict(overrides: Partial<Verdict> = {}): Verdict {
  return {
    id: 'verdict-1',
    caseId: 'case-orig',
    criterionId: 'k-1',
    status: 'ok',
    pass: false,
    model: { requested: 'fake', resolved: 'fake-resolved', transport: 'fake', pinned: false },
    cacheHit: false,
    ...overrides,
  };
}

async function pendingFileText(): Promise<string> {
  return readFile(join(dir, 'pending', 'promoted-2026-09-29.jsonl'), 'utf8');
}

describe('promoteFailure', () => {
  test('append: a failing, status ok verdict appends one PromotedCase line with provenance.promotedFrom', async () => {
    const verdict = failingVerdict();
    const did = promoteFailure(verdict, evalCase(), dir, { now: NOW });
    expect(did).toBe(true);

    const text = await pendingFileText();
    const lines = text.split('\n').filter((l) => l !== '');
    expect(lines).toHaveLength(1);
    const parsed = safeParseJson<Case>(lines[0] ?? '', {});
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toMatchObject({
      id: 'promoted-trace-abc-k-1',
      input: { state: 'user: hi\nassistant: hello' },
      traceId: 'trace-abc',
      provenance: {
        promotedFrom: {
          traceId: 'trace-abc',
          criterionId: 'k-1',
          verdictId: 'verdict-1',
          at: '2026-09-29T12:00:00.000Z',
        },
      },
    });
  });

  test('a verdict with no id is never promoted (dh8.5: no random-id fallback)', async () => {
    const noId: Verdict = {
      caseId: 'case-orig',
      criterionId: 'k-1',
      status: 'ok',
      pass: false,
      model: { requested: 'fake', resolved: 'fake-resolved', transport: 'fake', pinned: false },
      cacheHit: false,
    };
    expect(promoteFailure(noId, evalCase(), dir, { now: NOW })).toBe(false);
    await expect(pendingFileText()).rejects.toThrow();
  });

  test('duplicate skipped: the same traceId/criterionId is not appended twice in one file', async () => {
    const verdict = failingVerdict();
    expect(promoteFailure(verdict, evalCase(), dir, { now: NOW })).toBe(true);
    expect(promoteFailure(verdict, evalCase(), dir, { now: NOW })).toBe(false);

    const lines = (await pendingFileText()).split('\n').filter((l) => l !== '');
    expect(lines).toHaveLength(1);
  });

  test('passing verdict ignored: pass !== false never promotes', async () => {
    expect(promoteFailure(failingVerdict({ pass: true }), evalCase(), dir, { now: NOW })).toBe(
      false,
    );
    const unscored: Verdict = {
      caseId: 'case-orig',
      criterionId: 'k-1',
      status: 'ok',
      model: { requested: 'fake', resolved: 'fake-resolved', transport: 'fake', pinned: false },
      cacheHit: false,
    };
    expect(promoteFailure(unscored, evalCase(), dir, { now: NOW })).toBe(false);
    await expect(pendingFileText()).rejects.toThrow();
  });

  test('a non-ok status verdict is never promoted (unscored is not a failure)', async () => {
    const verdict = failingVerdict({ status: 'content_not_captured', pass: false });
    expect(promoteFailure(verdict, evalCase(), dir, { now: NOW })).toBe(false);
    await expect(pendingFileText()).rejects.toThrow();
  });

  test('no case to promote from (content not captured -> no input) is skipped, not thrown', () => {
    expect(promoteFailure(failingVerdict(), undefined, dir, { now: NOW })).toBe(false);
  });

  test('date rollover during a run writes to a new day file', async () => {
    const verdict = failingVerdict();
    promoteFailure(verdict, evalCase(), dir, { now: NOW });
    const nextDay = new Date('2026-09-30T00:00:00.001Z');
    promoteFailure(
      failingVerdict({ criterionId: 'k-2' }),
      evalCase({ traceId: 'trace-abc' }),
      dir,
      { now: nextDay },
    );
    const today = await pendingFileText();
    expect(today.split('\n').filter((l) => l !== '')).toHaveLength(1);
    const tomorrow = await readFile(join(dir, 'pending', 'promoted-2026-09-30.jsonl'), 'utf8');
    expect(tomorrow.split('\n').filter((l) => l !== '')).toHaveLength(1);
  });
});

describe('promoted cases and the J1 case loader', () => {
  test('roundtrip: loadCases pointed directly at the pending dir loads the promoted case', async () => {
    promoteFailure(failingVerdict(), evalCase(), dir, { now: NOW });
    const result = await loadCases(join(dir, 'pending'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cases).toHaveLength(1);
    expect(result.cases[0]).toMatchObject({ id: 'promoted-trace-abc-k-1' });
  });

  test('not loaded by default: loadCases at the cases dir itself never recurses into pending/', async () => {
    promoteFailure(failingVerdict(), evalCase(), dir, { now: NOW });
    const result = await loadCases(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cases).toHaveLength(0);
  });
});
