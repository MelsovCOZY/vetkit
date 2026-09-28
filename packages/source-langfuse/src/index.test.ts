import { describe, it, expect } from 'vitest';

describe('source-langfuse exports', () => {
  it('should export createLangfuseSource as a function', async () => {
    const mod = await import('./index.ts');
    expect(typeof mod.createLangfuseSource).toBe('function');
  });

  it('should export mapLangfuseTrace as a function', async () => {
    const mod = await import('./index.ts');
    expect(typeof mod.mapLangfuseTrace).toBe('function');
  });
});
