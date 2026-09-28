import { expectTypeOf, test } from 'vitest';
import type { JudgeV1 } from '@vetkit/spec';
import type { GeneratorEndpoint, JudgeEndpoint, ResolvedConfig, VetkitConfig } from './config.ts';

test('ResolvedConfig has a home for every configurable the root design names', () => {
  expectTypeOf<ResolvedConfig>().toHaveProperty('judge');
  expectTypeOf<ResolvedConfig>().toHaveProperty('generator');
  expectTypeOf<ResolvedConfig>().toHaveProperty('sources');
  expectTypeOf<ResolvedConfig>().toHaveProperty('sinks');
  expectTypeOf<ResolvedConfig>().toHaveProperty('thresholds');
  expectTypeOf<ResolvedConfig>().toHaveProperty('watch');
  expectTypeOf<ResolvedConfig>().toHaveProperty('gate');
  expectTypeOf<ResolvedConfig>().toHaveProperty('cacheDir');
});

test('defaulted fields are required after resolution', () => {
  expectTypeOf<ResolvedConfig['cacheDir']>().toEqualTypeOf<string>();
  expectTypeOf<ResolvedConfig['thresholds']['default']>().toEqualTypeOf<number>();
  expectTypeOf<ResolvedConfig['thresholds']['perCriterion']>().toEqualTypeOf<
    Record<string, number>
  >();
  expectTypeOf<ResolvedConfig['gate']['requireCalibrated']>().toEqualTypeOf<boolean>();
  expectTypeOf<ResolvedConfig['gate']['allowUnpinned']>().toEqualTypeOf<boolean>();
  expectTypeOf<ResolvedConfig['gate']['minPass']>().toEqualTypeOf<number | undefined>();
  expectTypeOf<ResolvedConfig['watch']['maxInFlight']>().toEqualTypeOf<number>();
  expectTypeOf<ResolvedConfig['watch']['sampleRate']>().toEqualTypeOf<number | undefined>();
  expectTypeOf<ResolvedConfig['watch']['upstreamSampleRate']>().toEqualTypeOf<number | undefined>();
});

test('a resolved judge is an endpoint or a JudgeV1 adapter, never a bare string', () => {
  expectTypeOf<JudgeEndpoint>().toExtend<ResolvedConfig['judge']>();
  expectTypeOf<JudgeV1>().toExtend<ResolvedConfig['judge']>();
  expectTypeOf<string>().not.toExtend<ResolvedConfig['judge']>();
});

test('JudgeEndpoint and GeneratorEndpoint document their fields', () => {
  expectTypeOf<JudgeEndpoint['kind']>().toEqualTypeOf<string>();
  expectTypeOf<JudgeEndpoint['preset']>().toEqualTypeOf<string | undefined>();
  expectTypeOf<JudgeEndpoint['accountId']>().toEqualTypeOf<string | undefined>();
  expectTypeOf<JudgeEndpoint['baseURL']>().toEqualTypeOf<string | undefined>();
  expectTypeOf<JudgeEndpoint['apiKeyEnv']>().toEqualTypeOf<string>();
  expectTypeOf<JudgeEndpoint['model']>().toEqualTypeOf<string | undefined>();
  expectTypeOf<JudgeEndpoint>().toHaveProperty('providerOptions');
  expectTypeOf<GeneratorEndpoint['kind']>().toEqualTypeOf<string>();
  expectTypeOf<GeneratorEndpoint['baseURL']>().toEqualTypeOf<string>();
  expectTypeOf<GeneratorEndpoint['apiKeyEnv']>().toEqualTypeOf<string>();
  expectTypeOf<GeneratorEndpoint['model']>().toEqualTypeOf<string>();
});

test('VetkitConfig accepts string | endpoint | adapter for judge and requires judge', () => {
  expectTypeOf<string>().toExtend<VetkitConfig['judge']>();
  expectTypeOf<JudgeEndpoint>().toExtend<VetkitConfig['judge']>();
  expectTypeOf<JudgeV1>().toExtend<VetkitConfig['judge']>();
  expectTypeOf<{ cacheDir: string }>().not.toExtend<VetkitConfig>();
});
