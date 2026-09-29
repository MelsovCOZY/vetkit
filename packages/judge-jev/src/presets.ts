// Wire dialect: this adapter speaks only the TypeSafe-compatible `/v1/systemone`
// dialect (noul/choice/score answers, snake_case wire fields) — transport.ts appends
// that suffix to every preset's baseURL. The gateway's `/v1/evaluate` dialect
// (boolean/probability answers, camelCase fields) and OpenRouter's `/alpha/decisions`
// are a different dialect entirely and are out of scope here.
//
// model.pinned: Vercel is an
// alias only, so it is pinned:false; so is Cloudflare Workers AI (no version is
// selectable); TypeSafe direct and OpenRouter each serve one
// fixed build, so they are pinned:true. Cloudflare speaks its own REST run endpoint
// (cloudflare.ts), not `/v1/systemone`.

export interface JevProviderOptions {
  readonly gateway: {
    readonly zeroDataRetention: boolean;
    readonly only: readonly string[];
  };
}

// A credential env var a preset needs, and what it is for. A preset is usable only when
// every one of its credentials is set; the first one is the bearer token.
export interface JevCredentialEnv {
  readonly name: string;
  readonly purpose: string;
}

export type JevEnv = Readonly<Record<string, string | undefined>>;

// Per-transport health probe: OpenRouter and Cloudflare health endpoints differ, so each
// preset gets its own probe rather than one shared shape.
export interface JevHealthEndpoint {
  readonly method: 'GET' | 'HEAD';
  readonly url: (env: JevEnv) => string;
}

// A price row for one transport (the per-transport price table lives here, as
// data with its source, never in logic). USD per 1M tokens; `asOf` is printed with estimates.
interface JevPricing {
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
  readonly source: string;
  readonly asOf: string;
}

export interface JevPreset {
  readonly baseURL: string;
  readonly defaultModel: string;
  readonly pinned: boolean;
  readonly providerOptions?: JevProviderOptions;
  readonly credentials: readonly JevCredentialEnv[];
  readonly health: JevHealthEndpoint;
  /** Absent when no price was measured: estimates then report cost 'unknown'. */
  readonly pricing?: JevPricing;
}

// Explicit `Record<..., JevPreset>` annotation (rather than `as const satisfies`,
// which --isolatedDeclarations rejects) keeps every entry structurally uniform, so
// `.providerOptions` is a valid (optional) access on any preset looked up by name.
export const JEV_PRESETS: Record<'typesafe' | 'vercel' | 'openrouter' | 'cloudflare', JevPreset> = {
  typesafe: {
    baseURL: 'https://api.typesafe.ai',
    defaultModel: 'jev-1.13.0',
    pinned: true,
    credentials: [
      { name: 'TYPESAFE_API_KEY', purpose: 'judge credential for the TypeSafe direct transport' },
    ],
    health: { method: 'GET', url: () => 'https://api.typesafe.ai/v1/models' },
  },
  vercel: {
    baseURL: 'https://ai-gateway.vercel.sh/typesafe',
    defaultModel: 'typesafe-ai/jev',
    pinned: false,
    // Verified against the live gateway ("ZDR requested: all 1 attempts support ZDR");
    // pins provider selection to typesafe-ai so the judge never silently hops hosts.
    providerOptions: {
      gateway: { zeroDataRetention: true, only: ['typesafe-ai'] },
    },
    credentials: [
      {
        name: 'AI_GATEWAY_API_KEY',
        purpose: 'judge credential for the Vercel AI Gateway transport (typesafe-ai/jev alias)',
      },
    ],
    health: { method: 'GET', url: () => 'https://ai-gateway.vercel.sh/typesafe/v1/models' },
    pricing: {
      inputPerMTok: 0.042,
      outputPerMTok: 0,
      source: 'measured in the pre-spike: 3.4M input tokens ≈ $0.143, output free',
      asOf: '2026-09-25',
    },
  },
  openrouter: {
    // Verified: probed live on 2026-09-29 through /api/v1/systemone; the pinned model
    // (typesafe/jev-1.13-20260917) resolved.
    baseURL: 'https://openrouter.ai/api',
    defaultModel: 'typesafe/jev-1.13',
    pinned: true,
    credentials: [
      {
        name: 'OPENROUTER_API_KEY',
        purpose: 'judge credential for the OpenRouter Decisions transport',
      },
    ],
    health: {
      method: 'GET',
      url: () => 'https://openrouter.ai/api/v1/models?output_modalities=all',
    },
  },
  cloudflare: {
    // UNVERIFIED: the {result, success, errors} REST envelope is taken from
    // Cloudflare's docs and has not been exercised with a real token yet.
    baseURL: 'https://api.cloudflare.com/client/v4',
    defaultModel: 'typesafe/jev',
    pinned: false,
    credentials: [
      {
        name: 'CLOUDFLARE_API_TOKEN',
        purpose:
          'judge credential (paired with CLOUDFLARE_ACCOUNT_ID) for the Cloudflare Workers AI transport',
      },
      {
        name: 'CLOUDFLARE_ACCOUNT_ID',
        purpose:
          'account id (paired with CLOUDFLARE_API_TOKEN) for the Cloudflare Workers AI transport',
      },
    ],
    health: {
      method: 'HEAD',
      url: (env) =>
        `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID ?? ''}/ai/run`,
    },
  },
};

export type JevPresetName = keyof typeof JEV_PRESETS;

// Tie-break order when credentials for more than one preset are set.
export const JEV_CREDENTIAL_PRIORITY: readonly JevPresetName[] = [
  'vercel',
  'openrouter',
  'cloudflare',
  'typesafe',
];
