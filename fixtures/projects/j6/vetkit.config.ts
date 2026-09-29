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
  sinks: [
    { kind: 'otel', endpoint: 'http://127.0.0.1:4318/v1/logs' },
    {
      kind: 'langfuse',
      baseUrlEnv: 'LANGFUSE_BASE_URL',
      publicKeyEnv: 'LANGFUSE_PUBLIC_KEY',
      secretKeyEnv: 'LANGFUSE_SECRET_KEY',
    },
  ],
};
