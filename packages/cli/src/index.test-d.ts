import { expectTypeOf, test } from 'vitest';
import type { JudgeV1 } from '@vetkit/spec';
import type * as Core from '@vetkit/core';
import { defineConfig } from './index.ts';
import type {
  GeneratorAdapter,
  GeneratorEndpoint,
  JudgeEndpoint,
  RegistryEntry,
  VetkitConfig,
} from './index.ts';
import type { JudgeV1 as ExportedJudgeV1 } from './index.ts';

declare const adapter: JudgeV1;

test('defineConfig from vetkit accepts a JudgeV1 adapter config and returns the same type', () => {
  const config = defineConfig({ judge: adapter, thresholds: { default: 0.7 } });
  expectTypeOf(config).toEqualTypeOf<{ judge: JudgeV1; thresholds: { default: number } }>();
});

test('defineConfig from vetkit accepts a typesafe-compatible endpoint config', () => {
  const config = defineConfig({
    judge: { kind: 'typesafe-compatible', preset: 'vercel', apiKeyEnv: 'KEY' },
  });
  expectTypeOf(config.judge).toHaveProperty('apiKeyEnv');
});

test('VetkitConfig, JudgeEndpoint, GeneratorEndpoint, GeneratorAdapter, RegistryEntry and JudgeV1 are exported types', () => {
  expectTypeOf<VetkitConfig>().toHaveProperty('judge');
  expectTypeOf<JudgeEndpoint>().toHaveProperty('kind');
  expectTypeOf<GeneratorEndpoint>().toEqualTypeOf<Core.GeneratorEndpoint>();
  expectTypeOf<GeneratorAdapter>().toEqualTypeOf<Core.GeneratorAdapter>();
  expectTypeOf<RegistryEntry>().toEqualTypeOf<Core.RegistryEntry>();
  expectTypeOf<ExportedJudgeV1>().toEqualTypeOf<JudgeV1>();
});
