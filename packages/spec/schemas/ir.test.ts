import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import type { JsonSchema } from '../src/json.ts';
import { parseIr } from './parseIr.ts';

// This file validates the IR's own schema files against fixture-built objects; it reads
// them with plain JSON.parse rather than the safeParseJson chokepoint (packages/spec/src/
// json.ts), same precedent as packages/spec/scripts/codegen.ts — scripts/
// ban-raw-json-parse.sh only bans packages/*/src, not packages/*/schemas. This file is
// also not part of the spec package's tsc project (tsconfig.json's `include` is `src`
// only), the same precedent as scripts/*.test.ts.

const SCHEMAS_DIR = join(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = join(SCHEMAS_DIR, '..', '..', '..');

function loadSchema(name: string): JsonSchema {
  const raw = readFileSync(join(SCHEMAS_DIR, `${name}.schema.json`), 'utf8');
  // Reading the IR's own schema fixtures, not application data; the trusted boundary
  // cast mirrors packages/spec/scripts/codegen.ts's loadSchema.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return JSON.parse(raw) as JsonSchema;
}

function loadFixture(name: string): unknown {
  const raw = readFileSync(join(REPO_ROOT, 'docs', 'research', 'fixtures', name), 'utf8');
  return JSON.parse(raw);
}

const criterionSchema = loadSchema('criterion');
const caseSchema = loadSchema('case');
const verdictSchema = loadSchema('verdict');

interface GatewayRequestFixture {
  questions: {
    promised_refund: { type: string; instructions: string };
    tone: { type: string; instructions: string; criteria: Record<string, string> };
    quality: { type: string; instructions: string; criteria: string[] };
  };
}

interface GatewayResponseFixture {
  answers: {
    promised_refund: { type: string; noul: number };
    tone: {
      type: string;
      choice: string;
      confidence: number;
      probabilities: Record<string, number>;
    };
    quality: {
      type: string;
      score: number;
      confidence: number;
      legend: Record<string, string>;
      probabilities: Record<string, number>;
    };
  };
}

const requestFixtureName = '2026-09-25-gateway-systemone-request.json';
const responseFixtureName = '2026-09-25-gateway-systemone-response-run1.json';

// Trusted boundary casts onto the two fixture files' known shapes.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const gatewayRequest = loadFixture(requestFixtureName) as GatewayRequestFixture;
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const gatewayResponse = loadFixture(responseFixtureName) as GatewayResponseFixture;

const model = {
  requested: 'typesafe-ai/jev',
  resolved: 'typesafe-ai/jev',
  transport: 'vercel-ai-gateway',
  pinned: false,
};

describe('criterion.schema.json', () => {
  // Question.type 'noul' is the TypeSafe wire name; the IR names the same question
  // 'boolean' (docs/contracts/j1.md: "adapters map boolean↔TypeSafe noul at the wire edge").
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
