import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { caseSchema, criterionSchema, specVersionSchema, verdictSchema } from './index.ts';
import { safeParseJson, validateJson } from './json.ts';

const SCHEMAS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'schemas');

// A JSON Schema of `{}` matches any JSON value; it lets this file read the IR's own
// schema files through the safeParseJson chokepoint (raw JSON.parse is banned in
// packages/*/src by scripts/ban-raw-json-parse.sh) purely to parse them, without
// needing a schema-of-schemas to validate the schema files themselves against.
function loadSchemaFile(name: string): unknown {
  const raw = readFileSync(join(SCHEMAS_DIR, `${name}.schema.json`), 'utf8');
  const result = safeParseJson<unknown>(raw, {});
  if (!result.ok) throw new Error(`failed to parse ${name}.schema.json`);
  return result.value;
}

describe('generated schema exports', () => {
  test('criterionSchema deep-equals schemas/criterion.schema.json', () => {
    expect(criterionSchema).toEqual(loadSchemaFile('criterion'));
  });

  test('caseSchema deep-equals schemas/case.schema.json', () => {
    expect(caseSchema).toEqual(loadSchemaFile('case'));
  });

  test('verdictSchema deep-equals schemas/verdict.schema.json', () => {
    expect(verdictSchema).toEqual(loadSchemaFile('verdict'));
  });

  test('specVersionSchema deep-equals schemas/version.schema.json', () => {
    expect(specVersionSchema).toEqual(loadSchemaFile('version'));
  });
});

describe('validateJson(obj, criterionSchema)', () => {
  const validCriterion = {
    id: 'promised_refund',
    type: 'boolean',
    instructions: 'Did the assistant promise a refund?',
    escape: 'unclear',
    polarity: 'pass_when_true',
    channel: 'outcome',
    provenance: { traceIds: ['trace-1'] },
    wordingHash: '0'.repeat(64),
  };

  test('accepts a fixture criterion', () => {
    const result = validateJson(validCriterion, criterionSchema);

    expect(result.ok).toBe(true);
  });

  test('rejects a criterion missing required fields', () => {
    const { wordingHash: _wordingHash, ...invalidCriterion } = validCriterion;

    const result = validateJson(invalidCriterion, criterionSchema);

    expect(result.ok).toBe(false);
  });
});
