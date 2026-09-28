// generated — do not edit

export type Answer = {
  type: 'boolean' | 'choice' | 'score';
  probability?: number;
  choice?: string;
  confidence?: number;
  probabilities?: {
    [k: string]: number;
  };
  score?: number;
  legend?: {
    [k: string]: string;
  };
} & Answer1;
export type Answer1 =
  | {
      type: 'boolean';
      probability: number;
    }
  | {
      type: 'choice';
      choice: string;
      confidence: number;
      probabilities: {
        [k: string]: number;
      };
    }
  | {
      type: 'score';
      score: number;
      confidence: number;
      legend: {
        [k: string]: string;
      };
      probabilities: {
        [k: string]: number;
      };
    };

export interface Verdict {
  id?: string;
  caseId: string;
  criterionId: string;
  status:
    | 'ok'
    | 'unscored'
    | 'error'
    | 'incomplete_trace'
    | 'truncated'
    | 'content_not_captured'
    | 'not_applicable'
    | 'infra_failure'
    | 'simulator_error';
  answer?: Answer;
  pass?: boolean;
  threshold?: number;
  model: Model;
  cacheHit: boolean;
  cause?: unknown;
  explanation?: string;
  gated?: boolean;
  gateReason?: 'score_not_gateable' | 'language_not_calibrated';
  borderline?: boolean;
  calibrated?: boolean;
  provenance?: {
    traceId?: string;
    spanId?: string;
    responseId?: string;
    observationId?: string;
    dialect?: string;
    schemaUrl?: string;
  };
}
export interface Model {
  requested: string;
  resolved: string;
  transport: string;
  pinned: boolean;
  provider?: string;
  releaseDate?: string;
}
