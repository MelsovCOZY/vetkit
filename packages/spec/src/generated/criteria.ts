// generated — do not edit

export type AuthoredCriterion = {
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
  enabled?: boolean;
  contentDependent?: boolean;
  provenance: {
    traceIds: string[];
    generator?: string;
  };
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
} & AuthoredCriterion1;
export type AuthoredCriterion1 =
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
      /**
       * @minItems 1
       */
      passWhen: [string, ...string[]];
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
    };

export interface CriteriaDoc {
  $schema?: string;
  schemaVersion?: number;
  criteria: AuthoredCriterion[];
}
