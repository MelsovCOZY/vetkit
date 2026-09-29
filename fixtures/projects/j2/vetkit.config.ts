// Config fixture for the J2 journey: the real generator and the
// real Jev judge (Vercel preset). Only env var NAMES appear here; keys come from the environment.
//
// The default generator is anthropic/claude-sonnet-5 on the Vercel gateway. A run can override it
// with a metered Gemini key; VETKIT_J2_GENERATOR=gateway selects the gateway generator.
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
