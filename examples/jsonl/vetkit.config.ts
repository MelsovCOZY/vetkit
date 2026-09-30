import { defineConfig, demoJudge } from 'vetkit';

// The demo judge runs offline and returns placeholder verdicts labelled 'demo'; it never gates.
// To judge for real, set OPENROUTER_API_KEY in .env and replace the line below with:
//   judge: { kind: 'typesafe-compatible', preset: 'openrouter', apiKeyEnv: 'OPENROUTER_API_KEY' },
export default defineConfig({
  judge: demoJudge,
  thresholds: { default: 0.5, perCriterion: {} },
});
