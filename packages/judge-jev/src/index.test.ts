import { describe, expect, it } from 'vitest';
import { createCloudflareTransport, createJevJudge, JEV_PRESETS, normalise } from './index.ts';

describe('@vetkit/judge-jev package entry', () => {
  it('re-exports createJevJudge as a function', () => {
    expect(typeof createJevJudge).toBe('function');
  });

  it('re-exports createCloudflareTransport as a function', () => {
    expect(typeof createCloudflareTransport).toBe('function');
  });

  it('re-exports normalise as a function', () => {
    expect(typeof normalise).toBe('function');
  });

  it('re-exports JEV_PRESETS with every preset name', () => {
    expect(Object.keys(JEV_PRESETS)).toEqual(['typesafe', 'vercel', 'openrouter', 'cloudflare']);
  });
});
