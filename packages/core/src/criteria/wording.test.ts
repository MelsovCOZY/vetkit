import { describe, expect, test } from 'vitest';
import type { Criterion } from '@vetkit/spec';
import { wordingOf as fromIndex } from '../index.ts';
import { computeWordingHash, type WordingFields } from './load.ts';
import { computeNormalizedWordingHash, wordingOf } from './wording.ts';
import { computeNormalizedWordingHash as fromBarrel } from '../index.ts';

const shared: Pick<Criterion, 'polarity' | 'channel' | 'provenance' | 'wordingHash'> = {
  polarity: 'pass_when_true',
  channel: 'outcome',
  provenance: { traceIds: ['t1'] },
  wordingHash: 'x',
};

const boolean: Criterion = {
  ...shared,
  id: 'b',
  type: 'boolean',
  instructions: 'Is it rude?',
  escape: 'No tone.',
};
const choice: Criterion = {
  ...shared,
  id: 'c',
  type: 'choice',
  instructions: 'Pick one',
  criteria: { a: 'first', b: 'second' },
  passWhen: ['a'],
  escape: 'None apply.',
};
const score: Criterion = {
  ...shared,
  id: 's',
  type: 'score',
  instructions: 'Rate it',
  criteria: ['bad', 'good'],
};

const cases: [string, Criterion, WordingFields][] = [
  ['boolean', boolean, { type: 'boolean', instructions: 'Is it rude?', escape: 'No tone.' }],
  [
    'choice',
    choice,
    {
      type: 'choice',
      instructions: 'Pick one',
      criteria: { a: 'first', b: 'second' },
      escape: 'None apply.',
    },
  ],
  ['score', score, { type: 'score', instructions: 'Rate it', criteria: ['bad', 'good'] }],
];

describe('wordingOf', () => {
  test('is exported from the package index', () => {
    expect(fromIndex).toBe(wordingOf);
  });

  test.each(cases)(
    '%s hashes identically to the hand-picked fields',
    (_name, criterion, picked) => {
      expect(computeWordingHash(wordingOf(criterion))).toBe(computeWordingHash(picked));
    },
  );

  test('omits absent optional keys and non-wording fields', () => {
    expect(Object.keys(wordingOf(score)).toSorted()).toEqual(['criteria', 'instructions', 'type']);
    expect(Object.keys(wordingOf(boolean)).toSorted()).toEqual(['escape', 'instructions', 'type']);
    expect(wordingOf(choice)).not.toHaveProperty('passWhen');
    expect(wordingOf(choice)).not.toHaveProperty('wordingHash');
  });
});

describe('computeNormalizedWordingHash', () => {
  const base: WordingFields = {
    type: 'choice',
    instructions: 'Pick one option\nfor the reply',
    criteria: { a: 'first one', b: 'second one' },
    escape: 'None apply.',
  };

  test('is exported from the package barrel', () => {
    expect(fromBarrel).toBe(computeNormalizedWordingHash);
  });

  test('is a sha256 hex digest', () => {
    expect(computeNormalizedWordingHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  test('absorbs whitespace runs inside a sentence, in every field', () => {
    const spaced: WordingFields = {
      type: 'choice',
      instructions: '  Pick   one\toption \r\n\n for the  reply ',
      criteria: { a: 'first   one', b: ' second\tone' },
      escape: 'None   apply. ',
    };
    expect(computeNormalizedWordingHash(spaced)).toBe(computeNormalizedWordingHash(base));
  });

  test('absorbs whitespace runs in score criteria arrays', () => {
    const rating: WordingFields = {
      type: 'score',
      instructions: 'Rate it',
      criteria: ['a b', 'c'],
    };
    const spaced: WordingFields = { ...rating, criteria: ['a   b', ' c '] };
    expect(computeNormalizedWordingHash(spaced)).toBe(computeNormalizedWordingHash(rating));
  });

  test('a one-word change gives a different hash', () => {
    const changed: WordingFields = { ...base, instructions: 'Pick one choice\nfor the reply' };
    expect(computeNormalizedWordingHash(changed)).not.toBe(computeNormalizedWordingHash(base));
  });

  test('keeps option order significant', () => {
    const swapped: WordingFields = { ...base, criteria: { b: 'second one', a: 'first one' } };
    expect(computeNormalizedWordingHash(swapped)).not.toBe(computeNormalizedWordingHash(base));
  });

  test('differs from computeWordingHash when the text has an inner double space', () => {
    const spaced: WordingFields = { ...base, escape: 'None  apply.' };
    expect(computeNormalizedWordingHash(spaced)).toBe(computeNormalizedWordingHash(base));
    expect(computeWordingHash(spaced)).not.toBe(computeWordingHash(base));
  });
});
