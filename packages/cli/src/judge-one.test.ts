import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FENCED_V1_PREAMBLE, renderState } from '@vetkit/core';
import { CEV_ERROR_CODES, validateJson, verdictSchema, VetError } from '@vetkit/spec';
import { describe, expect, test } from 'vitest';
import { judgeOne } from './index.ts';

// A temp project whose vetkit.config.ts holds an in-process fake judge: no network. Each
// doJudge call appends one line to calls.log, so the test counts real judge requests.
function fakeJudgeConfig(callsFile: string, requestFormat?: 'fenced-v1'): string {
  return `import { appendFileSync } from 'node:fs';
export default {
  judge: {
    specVersion: 'v1',
    id: 'fake-judge',
    capabilities: {
      questionTypes: ['boolean', 'choice', 'score'],
      maxStateTokens: 32000,
      pinned: false,
      transport: 'fake',
      model: 'fake-jev',${requestFormat === undefined ? '' : `\n      requestFormat: '${requestFormat}',`}
    },
    async doJudge(req) {
      appendFileSync(${JSON.stringify(callsFile)}, 'call\\n');
      appendFileSync(${JSON.stringify(callsFile + '.states')}, JSON.stringify(req.state) + '\\n');
      const answers = {};
      for (const key of Object.keys(req.questions)) {
        answers[key] = {
          type: 'choice',
          choice: 'yes',
          confidence: 0.9,
          probabilities: { yes: 0.9, no: 0.1, escape: 0 },
        };
      }
      return {
        answers,
        usage: { inputTokens: 1, outputTokens: 1 },
        model: { requested: 'fake-jev', resolved: 'fake-jev-resolved', transport: 'fake', pinned: false },
      };
    },
  },
};
`;
}

const criterion = {
  id: 'tone',
  type: 'boolean',
  instructions: 'Is the reply polite?',
  escape: 'The reply has no discernible tone.',
  polarity: 'pass_when_true',
  channel: 'quality',
  provenance: { traceIds: [] },
} as const;

const state = 'User: hi\nAssistant: Hello! How can I help?';

async function project(requestFormat?: 'fenced-v1'): Promise<{ root: string; callsFile: string }> {
  const root = await mkdtemp(join(tmpdir(), 'vetkit-judge-one-'));
  const callsFile = join(root, 'calls.log');
  await writeFile(join(root, 'vetkit.config.ts'), fakeJudgeConfig(callsFile, requestFormat));
  return { root, callsFile };
}

async function callCount(file: string): Promise<number> {
  try {
    return (await readFile(file, 'utf8')).split('\n').filter((l) => l !== '').length;
  } catch {
    return 0;
  }
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected judgeOne to reject');
}

describe('judgeOne', () => {
  test('is exported from the vetkit package entry as a function', () => {
    expect(typeof judgeOne).toBe('function');
  });

  test('returns a schema-valid ok Verdict from the configured fake judge', async () => {
    const { root, callsFile } = await project();
    const verdict = await judgeOne(
      { criterion, state },
      { configPath: join(root, 'vetkit.config.ts'), env: {} },
    );
    expect(validateJson(verdict, verdictSchema).ok).toBe(true);
    expect(verdict.status).toBe('ok');
    expect(verdict.criterionId).toBe('tone');
    expect(verdict.cacheHit).toBe(false);
    expect(verdict.model.resolved).toBe('fake-jev-resolved');
    expect(verdict.model.pinned).toBe(false);
    expect(await callCount(callsFile)).toBe(1);
  });

  test('sends a fenced state when the configured judge is fenced-v1', async () => {
    const { root, callsFile } = await project('fenced-v1');
    await judgeOne({ criterion, state }, { configPath: join(root, 'vetkit.config.ts'), env: {} });
    const [line] = (await readFile(`${callsFile}.states`, 'utf8')).split('\n');
    const sent = JSON.parse(line ?? '""') as string;
    expect(sent.startsWith(FENCED_V1_PREAMBLE)).toBe(true);
    expect(sent).toBe(renderState(state, 'fenced-v1'));
  });

  test('a second identical call is served from the cache with 0 judge requests', async () => {
    const { root, callsFile } = await project();
    const options = { configPath: join(root, 'vetkit.config.ts'), env: {} };
    await judgeOne({ criterion, state }, options);
    const before = await callCount(callsFile);
    const second = await judgeOne({ criterion, state }, options);
    expect(await callCount(callsFile)).toBe(before);
    expect(second.cacheHit).toBe(true);
    expect(second.status).toBe('ok');
  });

  test('resolves configPath against cwd', async () => {
    const { root } = await project();
    const verdict = await judgeOne(
      { criterion, state },
      { cwd: root, configPath: 'vetkit.config.ts', env: {} },
    );
    expect(verdict.status).toBe('ok');
  });

  test('an invalid criterion rejects CRITERIA_INVALID before any judge request', async () => {
    const { root, callsFile } = await project();
    // Deliberately outside the Criterion type: judgeOne validates at runtime.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const bad = { ...criterion, type: 'nonsense' } as unknown as typeof criterion;
    const error = await rejection(
      judgeOne({ criterion: bad, state }, { configPath: join(root, 'vetkit.config.ts'), env: {} }),
    );
    expect(VetError.isInstance(error) && error.code).toBe(CEV_ERROR_CODES.CRITERIA_INVALID);
    expect(await callCount(callsFile)).toBe(0);
  });

  test('a choice passWhen value outside its criteria map rejects CRITERIA_INVALID', async () => {
    const { root } = await project();
    const choice = {
      id: 'lang',
      type: 'choice',
      instructions: 'Which language is the reply in?',
      criteria: { en: 'English', fr: 'French' },
      escape: 'No reply.',
      passWhen: ['de'],
      polarity: 'pass_when_true',
      channel: 'quality',
      provenance: { traceIds: [] },
    } as const;
    const error = await rejection(
      judgeOne(
        { criterion: choice, state },
        { configPath: join(root, 'vetkit.config.ts'), env: {} },
      ),
    );
    expect(VetError.isInstance(error) && error.code).toBe(CEV_ERROR_CODES.CRITERIA_INVALID);
  });
});
