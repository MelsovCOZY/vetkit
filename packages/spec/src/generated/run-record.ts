// generated — do not edit

export interface RunRecordDoc {
  $schema: string;
  schemaVersion?: number;
  results: unknown[];
  summary: {};
  model: {};
  exitCode: 0 | 1 | 2 | 3 | 130;
  gateReasons: string[];
  criteriaPath: string;
  casesPath: string;
  startedAt: string;
  gateRequested: boolean;
  [k: string]: unknown;
}
