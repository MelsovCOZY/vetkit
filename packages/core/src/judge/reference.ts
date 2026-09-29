// Reference and code graders for Criterion.checkable factual/math/code criteria: a judge
// cannot grade what it cannot solve, so a checkable criterion either quotes the reference answer
// to the judge (renderReference) or is graded by a pure
// string/number comparison instead of the judge (gradeCode). referenceRequirement is the rule
// the lock writer consults to decide whether a checkable criterion may reach calibrated.
// Pure functions throughout — none of these ever throw.
import type { Case, Criterion } from '@vetkit/spec';

const REFERENCE_NOTE =
  'Treat the output as correct when it states the same answer; ignore wording, citation ' +
  'markers, language and formatting; numbers are equal when they express the same quantity.';

// expected.value is any JSON (case.schema.json): strings pass through, scalars use String(),
// null/arrays/objects render as JSON text so the judge and the exact/normalized checks never see
// "[object Object]" or an array's comma join.
function valueText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return JSON.stringify(value);
}

// Never place this output anywhere but a question's `instructions`: the reference
// answer must never enter `state`, the channel the judged output — and only the judged output —
// can reach.
export function renderReference(criterion: Criterion, evalCase: Case): string | null {
  if (criterion.grader?.kind !== 'reference') return null;
  if (evalCase.expected === undefined) return null;

  return `${criterion.instructions} Reference answer: ${valueText(evalCase.expected.value)}. ${REFERENCE_NOTE}`;
}

export type GradeCodeResult =
  | { status: 'ok'; pass: boolean; probability: 0 | 1 }
  | { status: 'not_applicable'; cause: 'reference_missing' | 'answer_missing' };

type CodeCheck = 'exact' | 'normalized' | 'numeric';

function isEmptyValue(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

const CITATION_MARKER_RE = /\[\d+\]/g;
const PUNCTUATION_RE = /\p{P}/gu;
const WHITESPACE_RE = /\s+/g;

function normalizeText(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('und')
    .replace(CITATION_MARKER_RE, '')
    .replace(PUNCTUATION_RE, '')
    .replace(WHITESPACE_RE, ' ')
    .trim();
}

// Locale-tolerant number tokenizer: thousand separators ',', ' ', '_'; decimal '.'; exponent
// 'e'/'E'. The grouped alternative requires at least one full 3-digit group after a separator
// (so "1 000" matches as one token without swallowing an unrelated trailing space); the plain
// `\d+` fallback covers ungrouped runs like "1000".
const NUMBER_RE = /[+-]?(?:\d{1,3}(?:[,_ ]\d{3})+|\d+)(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

function parseNumberToken(token: string): number | null {
  const cleaned = token.replace(/[,_ ]/g, '');
  if (cleaned === '' || cleaned === '+' || cleaned === '-') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// Multiple numbers in the answer compare against the last one (edge case: a model that shows
// its work before the final figure).
function lastNumber(text: string): number | null {
  const matches = text.match(NUMBER_RE);
  if (matches === null || matches.length === 0) return null;
  const lastMatch = matches[matches.length - 1];
  return lastMatch === undefined ? null : parseNumberToken(lastMatch);
}

function numericEqual(a: number, b: number): boolean {
  if (a === b) return true;
  const scale = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.abs(a - b) <= 1e-9 * scale;
}

function numericCheck(answer: string, expected: unknown): boolean {
  const answerNumber = lastNumber(answer);
  const expectedNumber = typeof expected === 'number' ? expected : lastNumber(valueText(expected));
  if (answerNumber === null || expectedNumber === null) return false;
  return numericEqual(answerNumber, expectedNumber);
}

function checkAnswer(check: CodeCheck, answer: string, expected: unknown): boolean {
  if (check === 'exact') return answer.trim() === valueText(expected).trim();
  if (check === 'normalized') return normalizeText(answer) === normalizeText(valueText(expected));
  return numericCheck(answer, expected);
}

export function gradeCode(criterion: Criterion, evalCase: Case): GradeCodeResult {
  const check = criterion.grader?.kind === 'code' ? criterion.grader.check : undefined;
  if (check === undefined) return { status: 'not_applicable', cause: 'reference_missing' };
  if (evalCase.expected === undefined || isEmptyValue(evalCase.expected.value)) {
    return { status: 'not_applicable', cause: 'reference_missing' };
  }
  if (evalCase.input.answer === undefined) {
    return { status: 'not_applicable', cause: 'answer_missing' };
  }

  const pass = checkAnswer(check, evalCase.input.answer, evalCase.expected.value);
  return { status: 'ok', pass, probability: pass ? 1 : 0 };
}

export type ReferenceRequirementResult =
  | { ok: true }
  | { ok: false; reason: 'reference_missing'; missing: string[] };

export function referenceRequirement(
  criterion: Criterion,
  cases: Case[],
): ReferenceRequirementResult {
  if (criterion.checkable === undefined) return { ok: true };

  const graderKind = criterion.grader?.kind;
  if (graderKind !== 'reference' && graderKind !== 'code') {
    return { ok: false, reason: 'reference_missing', missing: cases.map((c) => c.id) };
  }

  const missing = cases
    .filter((c) => c.expected === undefined || isEmptyValue(c.expected.value))
    .map((c) => c.id);
  if (missing.length > 0) return { ok: false, reason: 'reference_missing', missing };

  return { ok: true };
}
