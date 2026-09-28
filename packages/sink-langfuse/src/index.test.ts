import { describe, expect, it } from 'vitest';
import { createLangfuseSink, toLangfuseScore } from './index.ts';

describe('@vetkit/sink-langfuse package entry', () => {
  it('re-exports createLangfuseSink as a function', () => {
    expect(typeof createLangfuseSink).toBe('function');
  });

  it('re-exports toLangfuseScore as a function', () => {
    expect(typeof toLangfuseScore).toBe('function');
  });
});
