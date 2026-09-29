import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import type { JsonSchema } from '../src/json.ts';
import { parseIr } from './parseIr.ts';

// This file validates the IR's own schema files against objects built from inline fixtures; it reads
// them with plain JSON.parse rather than the safeParseJson chokepoint (packages/spec/src/
// json.ts), same precedent as packages/spec/scripts/codegen.ts — scripts/
// ban-raw-json-parse.sh only bans packages/*/src, not packages/*/schemas. This file is
// also not part of the spec package's tsc project (tsconfig.json's `include` is `src`
// only), the same precedent as scripts/*.test.ts.

const SCHEMAS_DIR = join(dirname(fileURLToPath(import.meta.url)));

function loadSchema(name: string): JsonSchema {
  const raw = readFileSync(join(SCHEMAS_DIR, `${name}.schema.json`), 'utf8');
  // Reading the IR's own schema fixtures, not application data; the trusted boundary
  // cast mirrors packages/spec/scripts/codegen.ts's loadSchema.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return JSON.parse(raw) as JsonSchema;
}

const criterionSchema = loadSchema('criterion');
const caseSchema = loadSchema('case');
const verdictSchema = loadSchema('verdict');

// Only the fields the tests below read, in the shape of a gateway System One request and response.
const gatewayRequest = {
  questions: {
    promised_refund: { instructions: 'Did the assistant promise or issue a refund?' },
    tone: {
      instructions: "What is the assistant's tone?",
      criteria: {
        helpful: 'Polite and solves the problem',
        rude: 'Dismissive or insulting',
        neutral: 'Neither warm nor rude',
      },
    },
    quality: {
      instructions: 'Rate the overall answer quality.',
      criteria: ['Wrong or harmful', 'Poor', 'Acceptable', 'Good', 'Excellent'],
    },
  },
};

const gatewayResponse = {
  answers: {
    quality: {
      score: 2.78,
      confidence: 0.26,
      legend: {
        '0': 'Wrong or harmful',
        '1': 'Poor',
        '2': 'Acceptable',
        '3': 'Good',
        '4': 'Excellent',
      },
      probabilities: { '0': 0.1, '1': 0.08, '2': 0.11, '3': 0.37, '4': 0.34 },
    },
  },
};

const model = {
  requested: 'typesafe-ai/jev',
  resolved: 'typesafe-ai/jev',
  transport: 'vercel-ai-gateway',
  pinned: false,
};

describe('criterion.schema.json', () => {
  // Question.type 'noul' is the TypeSafe wire name; the IR names the same question
  // 'boolean'; adapters map boolean↔TypeSafe noul at the wire edge.
  const booleanCriterion = {
    id: 'promised_refund',
    type: 'boolean',
    instructions: gatewayRequest.questions.promised_refund.instructions,
    escape: 'unclear',
    polarity: 'pass_when_true',
    channel: 'outcome',
    provenance: { traceIds: ['trace-1'] },
    wordingHash: '0'.repeat(64),
  };

  const choiceCriterion = {
    id: 'tone',
    type: 'choice',
    instructions: gatewayRequest.questions.tone.instructions,
    criteria: gatewayRequest.questions.tone.criteria,
    passWhen: ['helpful'],
    escape: 'unclear',
    polarity: 'pass_when_true',
    channel: 'quality',
    provenance: { traceIds: ['trace-1'] },
    wordingHash: '1'.repeat(64),
  };

  const scoreCriterion = {
    id: 'quality',
    type: 'score',
    instructions: gatewayRequest.questions.quality.instructions,
    criteria: gatewayRequest.questions.quality.criteria,
    polarity: 'pass_when_true',
    channel: 'quality',
    provenance: { traceIds: ['trace-1'] },
    wordingHash: '2'.repeat(64),
  };

  test('accepts a valid boolean, choice and score criterion built from the gateway fixture', () => {
    for (const criterion of [booleanCriterion, choiceCriterion, scoreCriterion]) {
      const result = parseIr(JSON.stringify(criterion), criterionSchema);
      expect(result.ok).toBe(true);
    }
  });

  test('rejects a score criterion with only 1 level (fixture has 5)', () => {
    const result = parseIr(
      JSON.stringify({ ...scoreCriterion, criteria: ['Only one level'] }),
      criterionSchema,
    );

    expect(result.ok).toBe(false);
  });

  test('rejects a boolean/choice criterion without an escape option', () => {
    const { escape: _escape, ...withoutEscape } = booleanCriterion;

    const result = parseIr(JSON.stringify(withoutEscape), criterionSchema);

    expect(result.ok).toBe(false);
  });

  test('rejects a code grader on a score criterion (code graders are boolean-only)', () => {
    const result = parseIr(
      JSON.stringify({
        ...scoreCriterion,
        checkable: 'math',
        grader: { kind: 'code', check: 'numeric' },
      }),
      criterionSchema,
    );

    expect(result.ok).toBe(false);
  });

  test('accepts a code grader on a boolean criterion', () => {
    const result = parseIr(
      JSON.stringify({
        ...booleanCriterion,
        checkable: 'code',
        grader: { kind: 'code', check: 'exact' },
      }),
      criterionSchema,
    );

    expect(result.ok).toBe(true);
  });

  test('rejects a wordingHash that is not lowercase hex sha256', () => {
    const result = parseIr(
      JSON.stringify({ ...booleanCriterion, wordingHash: 'NOT-HEX' }),
      criterionSchema,
    );

    expect(result.ok).toBe(false);
  });

  // Criterion.passWhen (choice only) and Criterion.escapeThreshold (0..1, default 0.5).
  test('accepts a choice criterion with passWhen and escapeThreshold', () => {
    const result = parseIr(
      JSON.stringify({ ...choiceCriterion, passWhen: ['helpful'], escapeThreshold: 0.7 }),
      criterionSchema,
    );

    expect(result.ok).toBe(true);
  });

  test('rejects passWhen on a score criterion (passWhen is choice-only)', () => {
    const result = parseIr(
      JSON.stringify({ ...scoreCriterion, passWhen: ['Good'] }),
      criterionSchema,
    );

    expect(result.ok).toBe(false);
  });

  test('rejects an escapeThreshold outside [0,1]', () => {
    const result = parseIr(
      JSON.stringify({ ...choiceCriterion, escapeThreshold: 1.5 }),
      criterionSchema,
    );

    expect(result.ok).toBe(false);
  });

  // contentDependent is an optional boolean; metadata is excluded from wordingHash.
  test('accepts a boolean criterion with contentDependent:false', () => {
    const result = parseIr(
      JSON.stringify({ ...booleanCriterion, contentDependent: false }),
      criterionSchema,
    );

    expect(result.ok).toBe(true);
  });

  // Rejected by contentDependent's own `{"type":"boolean"}` constraint, not by
  // additionalProperties.
  test('rejects contentDependent when it is not a boolean', () => {
    const result = parseIr(
      JSON.stringify({ ...booleanCriterion, contentDependent: 'yes' }),
      criterionSchema,
    );

    expect(result.ok).toBe(false);
  });
});

describe('case.schema.json', () => {
  const validCase = {
    id: 'case-1',
    input: {
      state: gatewayRequest.questions.promised_refund.instructions,
      answer: 'Yes, a refund of $80 was issued.',
    },
    provenance: {},
    tags: ['refund'],
    expected: { value: 'refund issued', source: 'user' },
    language: 'en-US',
    cluster: 'seed-1',
  };

  test('accepts a case with expected, language, cluster and input.answer all present', () => {
    const result = parseIr(JSON.stringify(validCase), caseSchema);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(validCase);
    }
  });

  test("rejects expected.source 'generated' (only user | code_verified are allowed)", () => {
    const result = parseIr(
      JSON.stringify({ ...validCase, expected: { value: 'x', source: 'generated' } }),
      caseSchema,
    );

    expect(result.ok).toBe(false);
  });
});

describe('verdict.schema.json', () => {
  const scoreVerdict = {
    caseId: 'case-1',
    criterionId: 'quality',
    status: 'ok',
    answer: {
      type: 'score',
      score: gatewayResponse.answers.quality.score,
      confidence: gatewayResponse.answers.quality.confidence,
      legend: gatewayResponse.answers.quality.legend,
      probabilities: gatewayResponse.answers.quality.probabilities,
    },
    model,
    cacheHit: false,
    gated: false,
    gateReason: 'score_not_gateable',
  };

  test('accepts a score verdict built from the gateway fixture with gated:false', () => {
    const result = parseIr(JSON.stringify(scoreVerdict), verdictSchema);

    expect(result.ok).toBe(true);
  });

  test('rejects a verdict with an unknown status', () => {
    const result = parseIr(JSON.stringify({ ...scoreVerdict, status: 'bogus' }), verdictSchema);

    expect(result.ok).toBe(false);
  });

  test('rejects a verdict carrying an answer when status is not ok', () => {
    const result = parseIr(JSON.stringify({ ...scoreVerdict, status: 'error' }), verdictSchema);

    expect(result.ok).toBe(false);
  });
});

describe('parseIr', () => {
  test('never throws on unparsable text and reports it as an issue', () => {
    expect(() => parseIr('{not json', criterionSchema)).not.toThrow();

    const result = parseIr('{not json', criterionSchema);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues[0]).toMatchObject({
        path: expect.any(String),
        message: expect.any(String),
      });
    }
  });

  test('never throws on schema-invalid JSON and reports each ajv error as an issue', () => {
    const result = parseIr('{}', criterionSchema);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.length).toBeGreaterThan(0);
      for (const issue of result.issues) {
        expect(typeof issue.path).toBe('string');
        expect(typeof issue.message).toBe('string');
      }
    }
  });

  test('returns {ok:true, value} for schema-valid JSON, never {ok:false}', () => {
    const validCase = {
      id: 'case-1',
      input: { state: 'User: hi\nAssistant: hello' },
      provenance: {},
      tags: [],
    };

    const result = parseIr(JSON.stringify(validCase), caseSchema);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(validCase);
    }
  });
});
