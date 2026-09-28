import { expectTypeOf, test } from 'vitest';
import type { Answer, JudgeResponse, JudgeV1, Question } from './judge.ts';

test('Question is a discriminated union of the three IR question types', () => {
  expectTypeOf<Question['type']>().toEqualTypeOf<'boolean' | 'choice' | 'score'>();
  expectTypeOf<Question>().toMatchTypeOf<{ instructions: string }>();
});

test('JudgeV1.doJudge takes one state+questions request and returns Promise<JudgeResponse>', () => {
  expectTypeOf<JudgeV1['doJudge']>().parameter(0).toEqualTypeOf<{
    state: string;
    questions: Record<string, Question>;
    signal?: AbortSignal;
  }>();
  expectTypeOf<JudgeV1['doJudge']>().returns.toEqualTypeOf<Promise<JudgeResponse>>();
});

test('JudgeV1.capabilities.questionTypes is an array of Question[type]', () => {
  expectTypeOf<JudgeV1['capabilities']['questionTypes']>().toEqualTypeOf<
    Array<'boolean' | 'choice' | 'score'>
  >();
});

test('JudgeResponse.model carries requested/resolved/transport/pinned', () => {
  expectTypeOf<JudgeResponse['model']>().toMatchTypeOf<{
    requested: string;
    resolved: string;
    transport: string;
    pinned: boolean;
  }>();
});

test('Answer is a discriminated union of the three IR answer shapes', () => {
  expectTypeOf<Answer['type']>().toEqualTypeOf<'boolean' | 'choice' | 'score'>();
});
