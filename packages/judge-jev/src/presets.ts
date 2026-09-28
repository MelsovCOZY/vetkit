// Wire dialect: this adapter speaks only the TypeSafe-compatible `/v1/systemone`
// dialect (noul/choice/score answers, snake_case wire fields) — transport.ts appends
// that suffix to every preset's baseURL. The gateway's `/v1/evaluate` dialect
// (boolean/probability answers, camelCase fields) and OpenRouter's `/alpha/decisions`
// are a different dialect entirely and are out of scope here (docs/contracts/j1.md
// "Ports"; root ledger PREMISE, live probe 2026-09-26).
//
// model.pinned (docs/contracts/j1.md "Ports", DECISION pinning honesty): Vercel is an
// alias only, so it is pinned:false; TypeSafe direct and OpenRouter each serve one
// fixed build, so they are pinned:true.

export interface JevProviderOptions {
  readonly gateway: {
    readonly zeroDataRetention: boolean;
    readonly only: readonly string[];
  };
}

export interface JevPreset {
  readonly baseURL: string;
  readonly defaultModel: string;
  readonly pinned: boolean;
  readonly providerOptions?: JevProviderOptions;
}

// Explicit `Record<..., JevPreset>` annotation (rather than `as const satisfies`,
// which --isolatedDeclarations rejects) keeps every entry structurally uniform, so
// `.providerOptions` is a valid (optional) access on any preset looked up by name.
export const JEV_PRESETS: Record<'typesafe' | 'vercel' | 'openrouter', JevPreset> = {
  typesafe: {
    baseURL: 'https://api.typesafe.ai',
    defaultModel: 'jev-1.13.0',
    pinned: true,
  },
  vercel: {
    baseURL: 'https://ai-gateway.vercel.sh/typesafe',
    defaultModel: 'typesafe-ai/jev',
    pinned: false,
    // PREMISE VERIFIED (probe 2026-09-25): honoured by the gateway ("ZDR requested:
    // all 1 attempts support ZDR") and pins provider selection to typesafe-ai so the
    // judge never silently hops hosts (root ledger DECISION).
    providerOptions: {
      gateway: { zeroDataRetention: true, only: ['typesafe-ai'] },
    },
  },
  openrouter: {
    // UNVERIFIED (contract RISK): OpenRouter's TypeSafe-compatible /api/v1/systemone
    // path is documented by OpenRouter but not probed here; treat as unverified until
    // the J3/J6 e2e exercises it.
    baseURL: 'https://openrouter.ai/api',
    defaultModel: 'typesafe/jev-1.13',
    pinned: true,
  },
};

export type JevPresetName = keyof typeof JEV_PRESETS;
