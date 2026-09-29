// Hand-written port types. These are TS-only
// shapes (the wire adapter, not the IR): every judge transport implements JudgeV1 and
// returns a JudgeResponse; Question/Answer are keyed per-criterion inside one doJudge
// call (the one-request-per-case rule).

export type Question =
  | { type: 'boolean'; instructions: string }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] }; // 2..10 levels

export type RequestFormat = 'raw' | 'fenced-v1';

export interface JudgeV1 {
  specVersion: 'v1';
  id: string;
  capabilities: {
    questionTypes: Array<Question['type']>;
    maxStateTokens: number;
    pinned: boolean;
    transport: string;
    model: string; // declared/requested model id (cache key, unscored model.requested)
    requestFormat?: RequestFormat;
  };
  doJudge(req: {
    state: string;
    questions: Record<string, Question>;
    signal?: AbortSignal;
  }): Promise<JudgeResponse>;
}

export interface JudgeResponse {
  answers: Record<string, Answer>;
  usage: { inputTokens: number; outputTokens: number };
  model: {
    requested: string;
    resolved: string;
    transport: string;
    pinned: boolean;
    provider?: string;
    credentialType?: string;
    releaseDate?: string;
  };
  raw?: unknown;
}

export type Answer =
  | { type: 'boolean'; probability: number }
  | { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }
  | {
      type: 'score';
      score: number;
      confidence: number;
      legend: Record<string, string>;
      probabilities: Record<string, number>;
    };
