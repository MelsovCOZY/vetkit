// J3 project. Judge: the real Jev alias through the vercel
// preset. Generator: an OpenAI-compatible chat model on the same gateway key, used only for
// the paraphrase and polarity gauntlets (Jev cannot generate text). Override the model with
// CEV_J3_GENERATOR_MODEL; without a generator those two gauntlets are `skipped`.
export default {
  judge: {
    kind: 'typesafe-compatible',
    preset: 'vercel',
    apiKeyEnv: 'AI_GATEWAY_API_KEY',
    providerOptions: { gateway: { zeroDataRetention: true, only: ['typesafe-ai'] } },
  },
  generator: {
    kind: 'openai-compatible',
    baseURL: 'https://ai-gateway.vercel.sh/v1',
    apiKeyEnv: 'AI_GATEWAY_API_KEY',
    model: process.env['CEV_J3_GENERATOR_MODEL'] ?? 'anthropic/claude-haiku-4.5',
  },
  thresholds: { default: 0.5, perCriterion: {} },
};
