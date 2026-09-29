import { describe, expect, test } from 'vitest';
import type { Criterion } from '@vetkit/spec';
import { wordingOf as fromIndex } from '../index.ts';
import { computeWordingHash, type WordingFields } from './load.ts';
import { wordingOf } from './wording.ts';

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
