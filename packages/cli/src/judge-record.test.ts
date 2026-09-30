import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { judgeCase } from '@vetkit/core';
import {
  VetError,
  safeParseJson,
  type Case,
  type Criterion,
  type JudgeResponse,
  type JudgeV1,
} from '@vetkit/spec';
import { describe, expect, test, vi } from 'vitest';
import { recordingJudge, replayJudge, requestKey } from './judge-record.ts';

const CAPABILITIES: JudgeV1['capabilities'] = {
  questionTypes: ['boolean', 'choice', 'score'],
  maxStateTokens: 32_000,
  pinned: false,
  transport: 'fake',
  model: 'fake-model',
};

const RESPONSE: JudgeResponse = {
  answers: { q: { type: 'boolean', probability: 0.9 } },
  usage: { inputTokens: 5, outputTokens: 1 },
  model: { requested: 'fake-model', resolved: 'fake-model-1', transport: 'fake', pinned: false },
  raw: { secret: 'never-recorded' },
};

function fake(): { judge: JudgeV1; doJudge: ReturnType<typeof vi.fn<JudgeV1['doJudge']>> } {
  const doJudge = vi.fn<JudgeV1['doJudge']>(() => Promise.resolve(RESPONSE));
  return {
    doJudge,
    judge: { specVersion: 'v1', id: 'fake-judge', capabilities: CAPABILITIES, doJudge },
  };
}

type JudgeRequest = Parameters<JudgeV1['doJudge']>[0];

function request(state: string): JudgeRequest {
  return {
    state,
    questions: { q: { type: 'choice', instructions: 'Ok?', criteria: { yes: 'Y', no: 'N' } } },
  };
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'vetkit-record-'));
}

function read(path: string): unknown {
  const parsed = safeParseJson<unknown>(readFileSync(path, 'utf8'), {});
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

describe('recording judge', () => {
  test('writes manifest and one keyed file per call with exactly answers/usage/model', async () => {
    const dir = tmp();
    const { judge } = fake();
    const recorder = recordingJudge(judge, dir, { version: '9.9.9' });
    const req = request('S1');
    const response = await recorder.doJudge(req);
    expect(response).toBe(RESPONSE);

    expect(read(join(dir, 'manifest.json'))).toEqual({
      recordVersion: 1,
      vetkit: '9.9.9',
      judge: { id: 'fake-judge', capabilities: CAPABILITIES },
    });
    const entry = read(join(dir, `${requestKey(req)}.json`));
    expect(Object.keys(Object(entry)).toSorted()).toEqual(['answers', 'model', 'usage']);
    expect(entry).toEqual({
      answers: RESPONSE.answers,
      usage: RESPONSE.usage,
      model: RESPONSE.model,
    });
  });

  test('never writes raw', async () => {
    const dir = tmp();
    const recorder = recordingJudge(fake().judge, dir, { version: '1.0.0' });
    await recorder.doJudge(request('S1'));
    for (const file of readdirSync(dir)) {
      expect(readFileSync(join(dir, file), 'utf8')).not.toContain('never-recorded');
    }
  });

  test('the key of a request is stable across calls with equal state and questions', async () => {
    const dir = tmp();
    const recorder = recordingJudge(fake().judge, dir, { version: '1.0.0' });
    expect(requestKey(request('S1'))).toMatch(/^[0-9a-f]{64}$/);
    expect(requestKey(request('S1'))).toBe(requestKey(request('S1')));
    expect(requestKey(request('S2'))).not.toBe(requestKey(request('S1')));
    await recorder.doJudge(request('S1'));
    await recorder.doJudge({ ...request('S1'), signal: new AbortController().signal });
    expect(readdirSync(dir).filter((f) => f !== 'manifest.json')).toHaveLength(1);
  });
});

async function recorded(): Promise<string> {
  const dir = tmp();
  await recordingJudge(fake().judge, dir, { version: '1.0.0' }).doJudge(request('S1'));
  return dir;
}

describe('replay judge', () => {
  test('answers from the recording without calling the wrapped judge', async () => {
    const dir = await recorded();
    const { judge, doJudge } = fake();
    const replay = replayJudge(dir);
    const response = await replay.doJudge(request('S1'));
    expect(response.answers).toEqual(RESPONSE.answers);
    expect(response.usage).toEqual(RESPONSE.usage);
    expect(response.model).toEqual(RESPONSE.model);
    expect(judge).toBeDefined();
    expect(doJudge).not.toHaveBeenCalled();
  });

  test('a missing entry rejects REPLAY_MISS (judgeCase turns it into unscored)', async () => {
    const replay = replayJudge(await recorded());
    const err = await replay.doJudge(request('other')).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(VetError.isInstance(err) && err.details?.hint).toBe('REPLAY_MISS');

    const evalCase: Case = { id: 'c1', input: { state: 'other' }, provenance: {}, tags: [] };
    const criterion: Criterion = {
      id: 'q',
      type: 'boolean',
      instructions: 'Ok?',
      escape: 'none',
      polarity: 'pass_when_true',
      channel: 'outcome',
      provenance: { traceIds: [] },
      wordingHash: 'h',
    };
    const verdicts = await judgeCase({ judge: replay, case: evalCase, criteria: [criterion] });
    expect(verdicts[0]).toMatchObject({
      status: 'unscored',
      cause: { errorType: 'REPLAY_MISS' },
    });
  });

  test('capabilities come from the manifest', async () => {
    const replay = replayJudge(await recorded());
    expect(replay.capabilities).toEqual(CAPABILITIES);
    expect(replay.specVersion).toBe('v1');
  });
});
