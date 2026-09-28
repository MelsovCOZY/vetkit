// Fixture project for `vet watch` (packages/cli/src/commands/watch.test.ts). The judge is an
// in-process JudgeV1: no network, and no CEV_JUDGE_FAKE env hook in production code — this
// config file is the fake (bead classified-evals-mol-dh8.3 acceptance criterion). //
// VETKIT_FIXTURE_MODE picks its behaviour: pass (default) -> P(yes) 0.9 · fail -> P(yes) 0.1.
type Answer = {
  type: 'choice';
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
};

const mode = process.env['VETKIT_FIXTURE_MODE'] ?? 'pass';
const model = `fake-jev-watch-${mode}`;

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
  async doJudge(req: { questions: Record<string, unknown> }) {
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
      usage: { inputTokens: 1, outputTokens: 1 },
      model: { requested: model, resolved: `${model}-resolved`, transport: 'fake', pinned: false },
    };
  },
};

export default { judge };
