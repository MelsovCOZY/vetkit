export { createProgram, run } from './program.ts';
export { createLogger } from './logger.ts';
export type { Logger, LoggerOptions, LogLevel } from './logger.ts';
export { judgeOne } from './judge-one.ts';
export type { JudgeOneCriterion, JudgeOneInput, JudgeOneOptions } from './judge-one.ts';
export { decideVerdict } from '@vetkit/core';
export { demoJudge } from './demo-judge.ts';
export { defineConfig } from '@vetkit/core';
export type {
  GeneratorAdapter,
  GeneratorEndpoint,
  JudgeEndpoint,
  RegistryEntry,
  VetkitConfig,
} from '@vetkit/core';
export type { JudgeV1 } from '@vetkit/spec';
