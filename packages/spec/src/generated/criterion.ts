// generated — do not edit

export type Criterion = {
  id: string;
  type: 'boolean' | 'choice' | 'score';
  instructions: string;
  criteria?:
    | {
        [k: string]: string;
      }
    | string[];
  escape?: string;
  passWhen?: string[];
  escapeThreshold?: number;
  polarity: 'pass_when_true' | 'pass_when_false';
  channel: 'outcome' | 'safety' | 'quality';
  provenance: {
    traceIds: string[];
    generator?: string;
  };
  wordingHash: string;
  checkable?: 'factual' | 'math' | 'code';
  grader?:
    | {
        kind: 'judge';
      }
    | {
        kind: 'reference';
      }
    | {
        kind: 'code';
        check: 'exact' | 'normalized' | 'numeric';
      };
} & (
  | {
      type: 'boolean';
      escape: unknown;
    }
  | {
      type: 'choice';
      escape: unknown;
      criteria: {
        [k: string]: string;
      };
      passWhen?: unknown;
    }
  | {
      type: 'score';
      /**
       * @minItems 2
       * @maxItems 10
       */
      criteria:
        | [string, string]
        | [string, string, string]
        | [string, string, string, string]
        | [string, string, string, string, string]
        | [string, string, string, string, string, string]
        | [string, string, string, string, string, string, string]
        | [string, string, string, string, string, string, string, string]
        | [string, string, string, string, string, string, string, string, string]
        | [string, string, string, string, string, string, string, string, string, string];
    }
);
