// J3 project for the planted-failure criteria: the same
// judge as fixtures/projects/j3 but no generator, so the paraphrase and polarity gauntlets are
// `skipped` and the run stays small. The planted criteria fail on the other gauntlets and the
// class-size rule; every skipped gauntlet also keeps a criterion uncalibrated.
export default {
  judge: {
    kind: 'typesafe-compatible',
    preset: 'vercel',
    apiKeyEnv: 'AI_GATEWAY_API_KEY',
    providerOptions: { gateway: { zeroDataRetention: true, only: ['typesafe-ai'] } },
  },
  thresholds: { default: 0.5, perCriterion: {} },
};
