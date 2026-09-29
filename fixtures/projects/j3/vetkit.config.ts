// J3 project. Judge: the real Jev alias through the vercel
// preset. Generator: an OpenAI-compatible chat model on the same gateway key, used only for
// the paraphrase and polarity gauntlets (Jev cannot generate text). Override the model with
// CEV_J3_GENERATOR_MODEL; without a generator those two gauntlets are `skipped`.
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
  generator: {
    kind: 'openai-compatible',
    baseURL: 'https://ai-gateway.vercel.sh/v1',
    apiKeyEnv: 'AI_GATEWAY_API_KEY',
    model: process.env['CEV_J3_GENERATOR_MODEL'] ?? 'anthropic/claude-haiku-4.5',
  },
  thresholds: { default: 0.5, perCriterion: {} },
};
