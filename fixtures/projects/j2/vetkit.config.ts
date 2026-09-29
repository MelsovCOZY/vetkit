// Config fixture for the J2 gate: the REAL generator and the
// REAL Jev judge (Vercel preset). Only env var NAMES appear here; keys come from the environment.
//
// The AC names anthropic/claude-sonnet-5 on the Vercel gateway. The gate run overrides that with
// the metered Gemini key (owner rule): VETKIT_J2_GENERATOR=gateway selects the AC's generator.
const gateway = process.env['VETKIT_J2_GENERATOR'] === 'gateway';

export default {
  generator: gateway
    ? {
        kind: 'openai-compatible',
        baseURL: 'https://ai-gateway.vercel.sh/v1',
        apiKeyEnv: 'AI_GATEWAY_API_KEY',
        model: 'anthropic/claude-sonnet-5',
        structured: 'json_schema',
      }
    : {
        kind: 'openai-compatible',
        baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
        apiKeyEnv: 'GEMINI_API_KEY',
        model: 'gemini-3.8-flash',
        structured: 'json_schema',
      },
  judge: {
    kind: 'typesafe-compatible',
    preset: 'vercel',
    apiKeyEnv: 'AI_GATEWAY_API_KEY',
    providerOptions: { gateway: { zeroDataRetention: true, only: ['typesafe-ai'] } },
  },
  thresholds: { default: 0.5, perCriterion: {} },
};
