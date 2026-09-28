// generated — do not edit

export interface Case {
  id: string;
  input: {
    state: string;
    answer?: string;
  };
  traceId?: string;
  provenance: unknown;
  tags: string[];
  expected?: {
    value: unknown;
    source: 'user' | 'code_verified';
  };
  language?: string;
  cluster?: string;
}
