// The demo judge: a deterministic, in-process JudgeV1 that never touches the network, so a
// first `vet run` works with no credentials. Its identity is unmistakable in every output:
// transport and model are both 'demo' and it is never pinned. Booleans are answered
// choice-shaped ('yes') because core reads `probabilities.yes` for that shape.
import type { Answer, JudgeV1, Question } from '@vetkit/spec';

export const DEMO_TRANSPORT = 'demo';

const CONFIDENCE = 0.9;
const REMAINDER = 0.1;

function abortError(): Error {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

function answer(question: Question): Answer {
  if (question.type === 'boolean') {
    return {
      type: 'choice',
      choice: 'yes',
      confidence: CONFIDENCE,
      probabilities: { yes: CONFIDENCE, no: REMAINDER, escape: 0 },
    };
  }
  if (question.type === 'choice') {
    const [first = '', ...rest] = Object.keys(question.criteria);
    const probabilities: Record<string, number> = { [first]: CONFIDENCE };
    for (const key of rest) probabilities[key] = REMAINDER / rest.length;
    return { type: 'choice', choice: first, confidence: CONFIDENCE, probabilities };
  }
  const middle = Math.floor((question.criteria.length - 1) / 2);
  const probabilities: Record<string, number> = {};
  const legend: Record<string, string> = {};
  for (const [level, label] of question.criteria.entries()) {
    probabilities[String(level)] =
      level === middle ? CONFIDENCE : REMAINDER / (question.criteria.length - 1);
    legend[String(level)] = label;
  }
  return { type: 'score', score: middle, confidence: CONFIDENCE, legend, probabilities };
}

export const demoJudge: JudgeV1 = Object.freeze<JudgeV1>({
  specVersion: 'v1',
  id: 'demo-judge',
  capabilities: {
    questionTypes: ['boolean', 'choice', 'score'],
    maxStateTokens: 32_000,
    pinned: false,
    transport: DEMO_TRANSPORT,
    model: 'demo',
  },
  doJudge(req) {
    if (req.signal?.aborted === true) return Promise.reject(abortError());
    const answers: Record<string, Answer> = {};
    for (const [key, question] of Object.entries(req.questions)) answers[key] = answer(question);
    return Promise.resolve({
      answers,
      usage: { inputTokens: 0, outputTokens: 0 },
      model: { requested: 'demo', resolved: 'demo', transport: DEMO_TRANSPORT, pinned: false },
    });
  },
});

export function isDemoJudge(judge: JudgeV1): boolean {
  return judge.capabilities.transport === DEMO_TRANSPORT;
}
