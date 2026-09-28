// Fixture project for `vet init --source` (packages/cli/src/commands/init.test.ts). Both
// judge and generator are in-process fake adapter objects: no network. VETKIT_FIXTURE_MODE
// picks how many distinct, lint-clean failure-mode/criterion pairs the fake generator
// proposes: 'many' (default) -> 6 (>= 5 survive lint+dedupe) · 'few' -> 2 (< 5 survive).
// The judge is only asked to dedupe near-duplicate criteria; these six are written to be
// textually distinct across channels, so it is normally never called.

interface FailureModeDraft {
  name: string;
  description: string;
  exampleTraceIds: string[];
}

interface CriterionDraft {
  failureMode: string;
  instructions: string;
  escape: string;
  polarity: 'pass_when_true' | 'pass_when_false';
  channel: 'outcome' | 'safety' | 'quality';
  checkable: 'none' | 'factual' | 'math' | 'code';
}

const ALL: { mode: FailureModeDraft; criterion: CriterionDraft }[] = [
  {
    mode: {
      name: 'parcel-status-vague',
      description:
        'The reply about a parcel gives a vague status instead of concrete tracking details.',
      exampleTraceIds: [],
    },
    criterion: {
      failureMode: 'parcel-status-vague',
      instructions:
        'Does the reply name a concrete parcel status such as a location or an estimated delivery date?',
      escape: 'The user did not ask about a parcel.',
      polarity: 'pass_when_true',
      channel: 'outcome',
      checkable: 'none',
    },
  },
  {
    mode: {
      name: 'greeting-lacks-offer',
      description: 'The greeting reply skips offering to help with anything specific.',
      exampleTraceIds: [],
    },
    criterion: {
      failureMode: 'greeting-lacks-offer',
      instructions: 'Does the reply invite the user to share what they need help with?',
      escape: 'The message is not a greeting.',
      polarity: 'pass_when_true',
      channel: 'quality',
      checkable: 'none',
    },
  },
  {
    mode: {
      name: 'weather-summary-thin',
      description:
        'The reply after a weather tool call gives a one-line summary instead of the temperature and conditions.',
      exampleTraceIds: [],
    },
    criterion: {
      failureMode: 'weather-summary-thin',
      instructions:
        'Does the reply state both the temperature and the weather conditions from the tool result?',
      escape: 'No weather tool result is present.',
      polarity: 'pass_when_true',
      channel: 'outcome',
      checkable: 'none',
    },
  },
  {
    mode: {
      name: 'refund-window-unspecific',
      description: 'The refund reply skips the exact number of days in the refund window.',
      exampleTraceIds: [],
    },
    criterion: {
      failureMode: 'refund-window-unspecific',
      instructions: 'Does the reply state a specific number of days for the refund window?',
      escape: 'The user did not ask about refunds.',
      polarity: 'pass_when_true',
      channel: 'outcome',
      checkable: 'none',
    },
  },
  {
    mode: {
      name: 'cancellation-confirmation-thin',
      description: 'The cancellation reply skips confirming which order id was cancelled.',
      exampleTraceIds: [],
    },
    criterion: {
      failureMode: 'cancellation-confirmation-thin',
      instructions: 'Does the reply confirm that the specific order id was cancelled?',
      escape: 'The user did not ask to cancel an order.',
      polarity: 'pass_when_true',
      channel: 'outcome',
      checkable: 'none',
    },
  },
  {
    mode: {
      name: 'tone-flat',
      description: 'The reply reads as flat rather than warm and professional.',
      exampleTraceIds: [],
    },
    criterion: {
      failureMode: 'tone-flat',
      instructions: 'Does the reply use a warm and professional tone?',
      escape: 'The reply is empty.',
      polarity: 'pass_when_true',
      channel: 'quality',
      checkable: 'none',
    },
  },
];

const drafts = process.env['VETKIT_FIXTURE_MODE'] === 'few' ? ALL.slice(0, 2) : ALL;

interface GenerateRequest {
  schema?: { name: string };
}

const generator = {
  specVersion: 'v1' as const,
  id: 'fake-generator',
  capabilities: { structured: 'json_schema' as const, streaming: false },
  async doGenerate(req: GenerateRequest) {
    const value =
      req.schema?.name === 'failure_modes'
        ? { failureModes: drafts.map((d) => d.mode) }
        : { criteria: drafts.map((d) => d.criterion) };
    return { value, resolvedModelId: 'fake-generator-resolved' };
  },
};

type Answer = {
  type: 'choice';
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
};

const judge = {
  specVersion: 'v1' as const,
  id: 'fake-judge',
  capabilities: {
    questionTypes: ['boolean' as const, 'choice' as const, 'score' as const],
    maxStateTokens: 32_000,
    pinned: false,
    transport: 'fake',
    model: 'fake-judge',
  },
  async doJudge(req: { questions: Record<string, { criteria: Record<string, string> }> }) {
    const answers: Record<string, Answer> = {};
    for (const key of Object.keys(req.questions)) {
      answers[key] = {
        type: 'choice',
        choice: 'none',
        confidence: 0.5,
        probabilities: { none: 0.5 },
      };
    }
    return {
      answers,
      usage: { inputTokens: 0, outputTokens: 1 },
      model: {
        requested: 'fake-judge',
        resolved: 'fake-judge-resolved',
        transport: 'fake',
        pinned: false,
      },
    };
  },
};

export default { judge, generator };
