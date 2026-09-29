// J3 project for the planted-failure criteria: the same
// judge as fixtures/projects/j3 but no generator, so the paraphrase and polarity gauntlets are
// `skipped` and the run stays small. The planted criteria fail on the other gauntlets and the
// class-size rule; every skipped gauntlet also keeps a criterion uncalibrated.
// Judge transport: CEV_SMOKE_JUDGE=vercel (default) or openrouter.
const smokeJudge = process.env['CEV_SMOKE_JUDGE'] ?? 'vercel';
if (smokeJudge !== 'vercel' && smokeJudge !== 'openrouter') {
  throw new Error(`CEV_SMOKE_JUDGE must be vercel or openrouter, got "${smokeJudge}"`);
}
const onVercel = smokeJudge === 'vercel';

export default {
  judge: {
    kind: 'typesafe-compatible',
    preset: smokeJudge,
    apiKeyEnv: onVercel ? 'AI_GATEWAY_API_KEY' : 'OPENROUTER_API_KEY',
    ...(onVercel
      ? { providerOptions: { gateway: { zeroDataRetention: true, only: ['typesafe-ai'] } } }
      : {}),
  },
  thresholds: { default: 0.5, perCriterion: {} },
};
