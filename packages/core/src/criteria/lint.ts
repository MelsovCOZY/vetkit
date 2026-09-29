// Lints Criterion[] against Jev's documented weak spots before any network call.
// Pure: no I/O, no node: imports. Rules are ASCII regex heuristics, so non-English wording is
// not checked (documented limitation).
import type { Criterion } from '@vetkit/spec';

export type LintSeverity = 'error' | 'warn';

export type LintRuleId =
  | 'ESCAPE_MISSING'
  | 'DOUBLE_NEGATIVE'
  | 'COMPUTATION'
  | 'NON_ATOMIC'
  | 'FORBIDDEN_WORD'
  | 'CONTRADICTS_INSTRUCTION'
  | 'INVERTED_BOOLEAN'
  | 'NEGATION_PAIR'
  | 'COMPOUND_LEVEL'
  | 'DEEP_INDIRECTION';

export interface LintRule {
  readonly id: LintRuleId;
  readonly severity: LintSeverity;
  /** One sentence: why Jev answers this kind of criterion badly. */
  readonly why: string;
  /** Docs URL ending in the rule's anchor. */
  readonly docs: string;
}

export interface LintIssue {
  readonly ruleId: LintRuleId;
  readonly severity: LintSeverity;
  readonly criterionId: string;
  /** JSON Pointer into the criteria document, e.g. `/criteria/0/instructions`. */
  readonly path: string;
  readonly message: string;
  readonly why: string;
  readonly docs: string;
  /** NEGATION_PAIR only: the other criterion of the pair. */
  readonly relatedCriterionId?: string;
}

export interface LintOptions {
  /** Replaces DEFAULT_FORBIDDEN_WORDS. */
  readonly forbiddenWords?: readonly string[];
}

export const DEFAULT_FORBIDDEN_WORDS: readonly string[] = [
  'good',
  'appropriate',
  'high quality',
  'properly',
];

const DOCS = 'https://vetkit.dev/docs/lint';

function rule(id: LintRuleId, severity: LintSeverity, why: string): LintRule {
  return { id, severity, why, docs: `${DOCS}#${id.toLowerCase().replaceAll('_', '-')}` };
}

export const LINT_RULES: readonly LintRule[] = [
  rule(
    'ESCAPE_MISSING',
    'error',
    'Jev must be able to decline when the evidence is missing, and removing the escape option took its accuracy from 0.95 to 0.00.',
  ),
  rule(
    'DOUBLE_NEGATIVE',
    'error',
    'Jev reads wording literally, so a double negative often gets the opposite answer to the one intended.',
  ),
  rule(
    'COMPUTATION',
    'error',
    'Jev is unreliable at counting, arithmetic, date comparison and colour codes, so route these to a code grader instead.',
  ),
  rule(
    'NON_ATOMIC',
    'error',
    'A question that bundles two verifiable claims gets one answer for both, so split it into one criterion per claim.',
  ),
  rule(
    'FORBIDDEN_WORD',
    'error',
    'Degree words like good or appropriate have no checkable meaning, so name the observable property instead.',
  ),
  rule(
    'CONTRADICTS_INSTRUCTION',
    'error',
    'A negatively phrased question with pass_when_false polarity stacks two inversions, so phrase it positively or flip the polarity.',
  ),
  rule(
    'INVERTED_BOOLEAN',
    'error',
    'A boolean whose yes-answer asserts an absence is answered less reliably than one asking whether the thing is present.',
  ),
  rule(
    'NEGATION_PAIR',
    'error',
    'Asking a question together with its negation measures wording sensitivity rather than the output, so keep one of the pair.',
  ),
  rule(
    'COMPOUND_LEVEL',
    'error',
    'An option or level that joins two conditions with and/or cannot be chosen when only one of them holds.',
  ),
  rule(
    'DEEP_INDIRECTION',
    'warn',
    'Instructions that point at other text instead of naming the field make Jev resolve references it often gets wrong.',
  ),
];

const RULES = new Map(LINT_RULES.map((r) => [r.id, r]));

function issueFor(
  ruleId: LintRuleId,
  criterion: Criterion,
  path: string,
  message: string,
): LintIssue {
  const r = RULES.get(ruleId) ?? rule(ruleId, 'error', 'See the lint rule documentation.');
  return {
    ruleId,
    severity: r.severity,
    criterionId: criterion.id,
    path,
    message,
    why: r.why,
    docs: r.docs,
  };
}

function normalise(text: string): string {
  return text.replaceAll(/[‘’]/g, "'").toLowerCase();
}

const DOUBLE_NEGATIVE = [
  /\bnot\s+un[a-z]+/,
  /\bnever\s+fails?\s+to\b/,
  // Two negations in one clause, e.g. "isn't not" or "isn't the reply not".
  /(?:n't|\bnot)\b[^?.]*\bnot\b/,
];

const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*';
const COMPUTATION = [
  /\bcount(?:s|ed|ing)?\b/,
  /\bhow many\b/,
  /\bsum\b/,
  /\baverage\b/,
  /\bcompare\b[^?.]*\bdates?\b/,
  new RegExp(
    `\\b(?:before|after|earlier than|later than)\\s+(?:\\d{1,4}[-/.]\\d{1,2}|\\d{4}\\b|${MONTH}\\b)`,
  ),
  /\bhex(?:adecimal)?\b/,
  /#[0-9a-f]{3,8}\b/,
  /\brgba?\b/,
];

// 'and'/'or' that opens a second clause: followed by an auxiliary verb, or after a comma.
const NON_ATOMIC =
  /\b(?:and|or)\s+(?:does|do|did|is|are|was|were|has|have|had|can|will|should)\b|,\s*(?:and|or)\s+(?:it|the|they)\b/;

const NEGATIVE = /\b(?:not|no|never|none|without|lacks?|fails?|missing|free of|avoids?)\b|n't\b/;

const INVERTED = [
  /\b(?:is|are) there no\b/,
  /\b(?:does|do|did)\b[^?.]*\b(?:lack|fail to|omit|neglect to)\b/,
  /\b(?:is|are|was|were)\b[^?.]*\b(?:missing|absent|lacking)\b/,
];

const INDIRECTION = [
  /\bas (?:described|mentioned|stated|noted|defined|shown|given) (?:above|below|earlier|previously|before)\b/,
  /\bthe \w+ (?:mentioned|referenced|referred to|described) in\b/,
  /\b(?:aforementioned|above-mentioned)\b/,
];
const REFERENCE = /\b(?:mentioned|referenced|referred to|cited|described|listed|quoted)\b/g;

const COMPOUND = /\b(?:and|or)\b/;

function escapeRegExp(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function options(criterion: Criterion): Array<readonly [string, string]> {
  const { criteria } = criterion;
  if (criteria === undefined) return [];
  if (Array.isArray(criteria)) return criteria.map((text, index) => [String(index), text] as const);
  return Object.entries(criteria);
}

function pointer(token: string): string {
  return token.replaceAll('~', '~0').replaceAll('/', '~1');
}

function checkCriterion(
  criterion: Criterion,
  index: number,
  forbidden: ReadonlyArray<readonly [string, RegExp]>,
): LintIssue[] {
  const base = `/criteria/${index}`;
  const at = `${base}/instructions`;
  const text = normalise(criterion.instructions);
  const issues: LintIssue[] = [];

  if (criterion.type !== 'score' && (criterion.escape ?? '').trim() === '') {
    issues.push(
      issueFor('ESCAPE_MISSING', criterion, `${base}/escape`, 'escape is missing or empty'),
    );
  }
  if (DOUBLE_NEGATIVE.some((re) => re.test(text))) {
    issues.push(issueFor('DOUBLE_NEGATIVE', criterion, at, 'instructions use a double negative'));
  }
  if (COMPUTATION.some((re) => re.test(text))) {
    issues.push(
      issueFor('COMPUTATION', criterion, at, 'instructions ask for counting, maths or dates'),
    );
  }
  if ((text.match(/\?/g) ?? []).length >= 2 || NON_ATOMIC.test(text)) {
    issues.push(issueFor('NON_ATOMIC', criterion, at, 'instructions ask more than one question'));
  }

  const fields: Array<readonly [string, string]> = [
    [at, text],
    ...options(criterion).map(
      ([key, value]) => [`${base}/criteria/${pointer(key)}`, normalise(value)] as const,
    ),
  ];
  for (const [path, value] of fields) {
    const hit = forbidden.find(([, re]) => re.test(value));
    if (hit !== undefined) {
      issues.push(issueFor('FORBIDDEN_WORD', criterion, path, `uses the degree word '${hit[0]}'`));
    }
  }
  for (const [path, value] of fields.slice(1)) {
    if (COMPOUND.test(value)) {
      issues.push(issueFor('COMPOUND_LEVEL', criterion, path, 'option joins two conditions'));
    }
  }

  if (criterion.polarity === 'pass_when_false' && NEGATIVE.test(text)) {
    issues.push(
      issueFor(
        'CONTRADICTS_INSTRUCTION',
        criterion,
        at,
        'negative instructions with pass_when_false polarity',
      ),
    );
  }
  if (criterion.type === 'boolean' && INVERTED.some((re) => re.test(text))) {
    issues.push(issueFor('INVERTED_BOOLEAN', criterion, at, 'yes-answer asserts an absence'));
  }
  if (INDIRECTION.some((re) => re.test(text)) || (text.match(REFERENCE) ?? []).length >= 2) {
    issues.push(issueFor('DEEP_INDIRECTION', criterion, at, 'instructions point at other text'));
  }
  return issues;
}

const NEGATION_TOKENS = /\b(?:not|no|never)\b/g;

function expandContractions(text: string): string {
  return text.replaceAll(/\bcan't\b/g, 'can not').replaceAll(/n't\b/g, ' not');
}

function stripNegation(text: string): string {
  return expandContractions(text)
    .replaceAll(NEGATION_TOKENS, ' ')
    .replaceAll(/[^a-z0-9' ]+/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

function negationCount(text: string): number {
  return (expandContractions(text).match(NEGATION_TOKENS) ?? []).length;
}

// Set-level: a question asked together with its negation.
function checkNegationPairs(criteria: readonly Criterion[]): LintIssue[] {
  const seen = new Map<string, { criterion: Criterion; negations: number }>();
  const issues: LintIssue[] = [];
  for (const [index, criterion] of criteria.entries()) {
    const text = normalise(criterion.instructions);
    const key = stripNegation(text);
    const negations = negationCount(text);
    const first = seen.get(key);
    if (first === undefined) {
      seen.set(key, { criterion, negations });
      continue;
    }
    if (first.negations % 2 !== negations % 2) {
      issues.push({
        ...issueFor(
          'NEGATION_PAIR',
          criterion,
          `/criteria/${index}/instructions`,
          `negates criterion '${first.criterion.id}'`,
        ),
        relatedCriterionId: first.criterion.id,
      });
    }
  }
  return issues;
}

export function lintCriteria(
  criteria: readonly Criterion[],
  lintOptions: LintOptions = {},
): LintIssue[] {
  const forbidden = (lintOptions.forbiddenWords ?? DEFAULT_FORBIDDEN_WORDS).map(
    (word) => [word, new RegExp(`\\b${escapeRegExp(normalise(word))}\\b`)] as const,
  );
  return [
    ...criteria.flatMap((criterion, index) => checkCriterion(criterion, index, forbidden)),
    ...checkNegationPairs(criteria),
  ];
}
