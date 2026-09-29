export default {
  judge: {
    kind: 'typesafe-compatible',
    preset: 'vercel',
    apiKeyEnv: 'AI_GATEWAY_API_KEY',
    providerOptions: { gateway: { zeroDataRetention: true, only: ['typesafe-ai'] } },
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
