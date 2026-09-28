import { describe, expect, it } from 'vitest';
import { JEV_CREDENTIAL_PRIORITY, JEV_PRESETS } from './index.ts';

const env = { CLOUDFLARE_ACCOUNT_ID: 'acct-123' };

describe('JEV_PRESETS credential metadata', () => {
  it('names the credential env var(s) and their purpose for each preset', () => {
    const credentials = Object.fromEntries(
      Object.entries(JEV_PRESETS).map(([name, preset]) => [
        name,
        preset.credentials.map((c) => c.name),
      ]),
    );
    expect(credentials).toEqual({
      typesafe: ['TYPESAFE_API_KEY'],
      vercel: ['AI_GATEWAY_API_KEY'],
      openrouter: ['OPENROUTER_API_KEY'],
      cloudflare: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'],
    });
    for (const preset of Object.values(JEV_PRESETS)) {
      for (const credential of preset.credentials) {
        expect(credential.purpose.length).toBeGreaterThan(0);
      }
    }
  });

  it('orders presets for credential tie-breaking', () => {
    expect(JEV_CREDENTIAL_PRIORITY).toEqual(['vercel', 'openrouter', 'cloudflare', 'typesafe']);
  });
});

describe('JEV_PRESETS health endpoint', () => {
  it('describes each preset health probe as a method and a url(env) builder', () => {
    const health = Object.fromEntries(
      Object.entries(JEV_PRESETS).map(([name, preset]) => [
        name,
        { method: preset.health.method, url: preset.health.url(env) },
      ]),
    );
    expect(health).toEqual({
      typesafe: { method: 'GET', url: 'https://api.typesafe.ai/v1/models' },
      vercel: { method: 'GET', url: 'https://ai-gateway.vercel.sh/typesafe/v1/models' },
      openrouter: {
        method: 'GET',
        url: 'https://openrouter.ai/api/v1/models?output_modalities=all',
      },
      cloudflare: {
        method: 'HEAD',
        url: 'https://api.cloudflare.com/client/v4/accounts/acct-123/ai/run',
      },
    });
  });
});

describe('JEV_PRESETS pricing', () => {
  it('prices the gateway alias preset at $0.042 per 1M input tokens, output free', () => {
    expect(JEV_PRESETS.vercel.pricing).toMatchObject({ inputPerMTok: 0.042, outputPerMTok: 0 });
  });

  it('gives every price row an auditable source and an ISO asOf date', () => {
    for (const preset of Object.values(JEV_PRESETS)) {
      if (preset.pricing === undefined) continue;
      expect(preset.pricing.source.length).toBeGreaterThan(0);
      expect(preset.pricing.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});
