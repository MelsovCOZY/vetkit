// Fixture project for `vet run` (packages/cli/src/commands/run.test.ts). The judge is an
// in-process JudgeV1: no network. VETKIT_FIXTURE_MODE picks its behaviour:
//   pass (default) → P(yes) 0.9 · fail → P(yes) 0.1 · slow → waits until aborted.
// In slow mode it creates the file named by VETKIT_FIXTURE_STARTED once a request is in
// flight, so a test knows when to send SIGINT. VETKIT_FIXTURE_KEY stands in for a secret
// a real adapter would hold; it must never appear in the CLI's output.
import { writeFileSync } from 'node:fs';

type Answer = {
  type: 'choice';
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
};

const mode = process.env['VETKIT_FIXTURE_MODE'] ?? 'pass';
const secret = process.env['VETKIT_FIXTURE_KEY'] ?? '';
const model = `fake-jev-${mode}`;

function waitForAbort(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    const started = process.env['VETKIT_FIXTURE_STARTED'];
    if (started !== undefined) writeFileSync(started, 'started');
    // A pending promise alone does not keep node alive; a real judge's fetch would.
    const keepAlive = setTimeout(() => {}, 60_000);
    const fail = (): void => {
      clearTimeout(keepAlive);
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    };
    if (signal?.aborted === true) fail();
    signal?.addEventListener('abort', fail, { once: true });
  });
}

const judge = {
  specVersion: 'v1' as const,
  id: 'fake-judge',
  capabilities: {
    questionTypes: ['boolean' as const, 'choice' as const, 'score' as const],
    maxStateTokens: 32_000,
    pinned: false,
    transport: 'fake',
    model,
  },
  async doJudge(req: { questions: Record<string, unknown>; signal?: AbortSignal }) {
    if (mode === 'slow') await waitForAbort(req.signal);
    const yes = mode === 'fail' ? 0.1 : 0.9;
    const answers: Record<string, Answer> = {};
    for (const key of Object.keys(req.questions)) {
      answers[key] = {
        type: 'choice',
        choice: yes >= 0.5 ? 'yes' : 'no',
        confidence: 0.9,
        probabilities: { yes, no: 1 - yes, escape: 0 },
      };
    }
    return {
      answers,
      usage: { inputTokens: secret.length, outputTokens: 1 },
      model: { requested: model, resolved: `${model}-resolved`, transport: 'fake', pinned: false },
    };
  },
};

export default { judge };
