import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Criterion } from '@vetkit/spec';
import { describe, expect, test } from 'vitest';
import { loadCriteria } from './load.ts';
import { DEFAULT_FORBIDDEN_WORDS, LINT_RULES, lintCriteria, type LintRuleId } from './lint.ts';

const fixtures = fileURLToPath(new URL('../../../../fixtures/', import.meta.url));

const RULE_FIXTURES: ReadonlyArray<readonly [string, LintRuleId]> = [
  ['escape-missing', 'ESCAPE_MISSING'],
  ['double-negative', 'DOUBLE_NEGATIVE'],
  ['computation', 'COMPUTATION'],
  ['non-atomic', 'NON_ATOMIC'],
  ['forbidden-word', 'FORBIDDEN_WORD'],
  ['contradicts-instruction', 'CONTRADICTS_INSTRUCTION'],
  ['inverted-boolean', 'INVERTED_BOOLEAN'],
  ['negation-pair', 'NEGATION_PAIR'],
  ['compound-level', 'COMPOUND_LEVEL'],
  ['deep-indirection', 'DEEP_INDIRECTION'],
];

async function load(relative: string): Promise<Criterion[]> {
  const result = await loadCriteria(join(fixtures, relative));
  if (!result.ok) throw new Error(`fixture ${relative} did not load: ${JSON.stringify(result)}`);
  return result.criteria;
}

function boolean(
  instructions: string,
  extra: { escape?: string; polarity?: Criterion['polarity'] } = {},
): Criterion {
  return {
    id: 'c',
    type: 'boolean',
    instructions,
    escape: extra.escape ?? 'The reply is empty.',
    polarity: extra.polarity ?? 'pass_when_true',
    channel: 'quality',
    provenance: { traceIds: [] },
    wordingHash: '0'.repeat(64),
  };
}

function score(levels: [string, string]): Criterion {
  return {
    id: 's',
    type: 'score',
    instructions: 'How helpful is the reply?',
    criteria: levels,
    polarity: 'pass_when_true',
    channel: 'quality',
    provenance: { traceIds: [] },
    wordingHash: '0'.repeat(64),
  };
}

function ruleIds(criteria: readonly Criterion[]): string[] {
  return [...new Set(lintCriteria(criteria).map((issue) => issue.ruleId))];
}

describe('lintCriteria fixtures', () => {
  test.each(RULE_FIXTURES)('fixtures/lint-bad/%s.yaml yields exactly %s', async (file, id) => {
    const criteria = await load(`lint-bad/${file}.yaml`);

    expect(ruleIds(criteria)).toEqual([id]);
  });

  test('every rule fixture file exists under fixtures/lint-bad/', async () => {
    const files = await readdir(join(fixtures, 'lint-bad'));

    expect(files).toEqual(expect.arrayContaining(RULE_FIXTURES.map(([f]) => `${f}.yaml`)));
  });

  test('fixtures/lint-good/valid.yaml yields zero issues', async () => {
    const criteria = await load('lint-good/valid.yaml');

    expect(criteria.length).toBeGreaterThan(0);
    expect(lintCriteria(criteria)).toEqual([]);
  });
});

describe('lint issue shape', () => {
  test.each(RULE_FIXTURES)('%s issues carry a one-sentence why and a docs anchor', async (file) => {
    const issues = lintCriteria(await load(`lint-bad/${file}.yaml`));

    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(issue.why.trim().length).toBeGreaterThan(0);
      expect(issue.why).toMatch(/\.$/);
      expect(issue.why).not.toMatch(/[.!?]\s+[A-Z]/);
      expect(issue.docs).toMatch(/#[a-z-]+$/);
      expect(issue.criterionId.length).toBeGreaterThan(0);
      expect(issue.path).toMatch(/^\/criteria\/\d+/);
      expect(issue.message.length).toBeGreaterThan(0);
    }
  });

  test('LINT_RULES lists every rule id with a non-empty why and docs anchor', () => {
    const ids = LINT_RULES.map((rule) => rule.id);

    expect(ids).toEqual(expect.arrayContaining(RULE_FIXTURES.map(([, id]) => id)));
    for (const rule of LINT_RULES) {
      expect(rule.why.trim().length).toBeGreaterThan(0);
      expect(rule.docs).toMatch(/#[a-z-]+$/);
    }
  });

  test('ESCAPE_MISSING why says Jev must be able to decline and cites 0.95 -> 0.00', () => {
    const rule = LINT_RULES.find((r) => r.id === 'ESCAPE_MISSING');

    expect(rule?.why).toMatch(/decline/);
    expect(rule?.why).toMatch(/0\.95/);
    expect(rule?.why).toMatch(/0\.00/);
  });

  test('DEEP_INDIRECTION warns; FORBIDDEN_WORD and the other eight rules are errors', () => {
    const severity = new Map(LINT_RULES.map((rule) => [rule.id, rule.severity]));

    expect(severity.get('DEEP_INDIRECTION')).toBe('warn');
    for (const [, id] of RULE_FIXTURES) {
      if (id === 'DEEP_INDIRECTION') continue;
      expect(severity.get(id)).toBe('error');
    }
  });
});

describe('lint rules', () => {
  test('lint.ts has no node: imports', async () => {
    const source = await readFile(fileURLToPath(new URL('./lint.ts', import.meta.url)), 'utf8');

    expect(source).not.toMatch(/from\s+['"]node:/);
    expect(source).not.toMatch(/import\(\s*['"]node:/);
  });

  test('a boolean with a whitespace-only escape is ESCAPE_MISSING', () => {
    expect(ruleIds([boolean('Does the reply greet the user?', { escape: '   ' })])).toEqual([
      'ESCAPE_MISSING',
    ]);
  });

  test('a score criterion never raises ESCAPE_MISSING', () => {
    expect(ruleIds([score(['unhelpful', 'helpful'])])).toEqual([]);
  });

  test.each(['Does the reply never fail to cite a source?', "Isn't the reply not polite?"])(
    'DOUBLE_NEGATIVE: %s',
    (text) => {
      expect(ruleIds([boolean(text)])).toContain('DOUBLE_NEGATIVE');
    },
  );

  test.each([
    'How many links does the reply include?',
    'Does the reply count three steps?',
    'Is the average rating above four?',
    'Is the delivery date before 2025-01-01?',
    'Is the meeting after March?',
    'Is the colour the hex value #ff0000?',
    'Does the reply give an RGB triple?',
  ])('COMPUTATION: %s', (text) => {
    expect(ruleIds([boolean(text)])).toContain('COMPUTATION');
  });

  test('NON_ATOMIC: two question marks', () => {
    expect(ruleIds([boolean('Is the reply polite? Is it short?')])).toContain('NON_ATOMIC');
  });

  test('FORBIDDEN_WORD honours a configured word list', () => {
    const criteria = [boolean('Is the reply stellar?')];

    expect(lintCriteria(criteria).map((i) => i.ruleId)).not.toContain('FORBIDDEN_WORD');
    expect(lintCriteria(criteria, { forbiddenWords: ['stellar'] }).map((i) => i.ruleId)).toEqual([
      'FORBIDDEN_WORD',
    ]);
  });

  test('DEFAULT_FORBIDDEN_WORDS holds the four default words', () => {
    expect(DEFAULT_FORBIDDEN_WORDS).toEqual(
      expect.arrayContaining(['good', 'appropriate', 'high quality', 'properly']),
    );
  });

  test('FORBIDDEN_WORD matches whole words only', () => {
    expect(ruleIds([boolean('Does the reply say goodbye?')])).not.toContain('FORBIDDEN_WORD');
  });

  test('CONTRADICTS_INSTRUCTION needs pass_when_false', () => {
    const text = 'Does the reply not mention the price?';

    expect(ruleIds([boolean(text)])).not.toContain('CONTRADICTS_INSTRUCTION');
    expect(ruleIds([boolean(text, { polarity: 'pass_when_false' })])).toContain(
      'CONTRADICTS_INSTRUCTION',
    );
  });

  test.each([
    'Is there no greeting in the reply?',
    'Does the reply fail to cite a source?',
    'Is the signature missing?',
  ])('INVERTED_BOOLEAN: %s', (text) => {
    expect(ruleIds([boolean(text)])).toContain('INVERTED_BOOLEAN');
  });

  test('NEGATION_PAIR points at the earlier criterion of the pair', async () => {
    const issues = lintCriteria(await load('lint-bad/negation-pair.yaml'));

    expect(issues).toContainEqual(
      expect.objectContaining({
        ruleId: 'NEGATION_PAIR',
        criterionId: 'omits-refund',
        relatedCriterionId: 'mentions-refund',
      }),
    );
  });

  test('COMPOUND_LEVEL flags a score level joined with or', () => {
    expect(lintCriteria([score(['unhelpful or rude', 'helpful'])])).toContainEqual(
      expect.objectContaining({ ruleId: 'COMPOUND_LEVEL', path: '/criteria/0/criteria/0' }),
    );
  });

  test.each([
    'Does the reply use the value mentioned in the ticket?',
    'Does the reply repeat the figure cited by the user, as listed in the order?',
  ])('DEEP_INDIRECTION: %s', (text) => {
    expect(ruleIds([boolean(text)])).toContain('DEEP_INDIRECTION');
  });

  test('non-English text raises no ASCII-pattern issues', () => {
    expect(lintCriteria([boolean('Отвечает ли ответ на вопрос пользователя?')])).toEqual([]);
  });
});
