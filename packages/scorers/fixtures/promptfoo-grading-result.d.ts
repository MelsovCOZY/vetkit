// Trimmed, test-only copy of promptfoo's `GradingResult` (src/types/index.ts) — imported only
// from src/promptfoo.test.ts to assert toPromptfooAssertion's return shape against it; never
// imported from src/ and never shipped (package.json "files" is ["dist"] only). This package
// declares zero dependency on the promptfoo package itself.
//
// `graderError` is narrowed to `boolean` here so that
// graderError:true means only a transport failure rather than promptfoo's own broader type;
// re-verify against the upstream file before shipping if that type ever changes.
export interface GradingResult {
  pass: boolean;
  score: number;
  reason: string;
  namedScores?: Record<string, number>;
  metadata?: Record<string, unknown>;
  graderError?: boolean;
}
