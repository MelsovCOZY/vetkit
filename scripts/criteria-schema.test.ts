import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  formatCriteriaDocument,
  loadCriteria,
  parseCriteriaDocument,
  setEnabled,
} from '@vetkit/core';
import { validateJson, type JsonSchema } from '@vetkit/spec';
import { describe, expect, test } from 'vitest';
import { parse as parseYaml } from 'yaml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA_ID = 'https://melsovcozy.github.io/vetkit/schemas/criteria.schema.json';
const MODELINE = `# yaml-language-server: $schema=${SCHEMA_ID}`;
const templatePath = join(ROOT, 'packages/cli/templates/criteria.yaml');

interface SchemaDoc {
  $schema?: string;
  $id?: string;
  title?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  oneOf?: unknown[];
  $defs?: { authoredCriterion?: SchemaDoc };
}

function readSchema(name: string): SchemaDoc {
  const text = readFileSync(join(ROOT, 'packages/spec/schemas', `${name}.schema.json`), 'utf8');
  // Reading the IR's own schema files, same precedent as packages/spec/schemas/ir.test.ts.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return JSON.parse(text) as SchemaDoc;
}

function withoutWordingHash(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutWordingHash);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'wordingHash')
      .map(([key, inner]) => [key, withoutWordingHash(inner)]),
  );
}

const template = readFileSync(templatePath, 'utf8');

// A static relative import into another tsc project is rejected (TS2878), and the spec
// index does not re-export criteriaSchema, so the generated module is imported by variable.
const GENERATED_SCHEMAS = '../packages/spec/src/generated/schemas.ts';
const generated: { criteriaSchema?: JsonSchema } = await import(GENERATED_SCHEMAS);
const criteriaSchema: JsonSchema = generated.criteriaSchema ?? {};

describe('criteria.schema.json', () => {
  test('criteria.schema.json is draft 2020-12 with the Pages $id', () => {
    const schema = readSchema('criteria');
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema.$id).toBe(SCHEMA_ID);
    expect(schema.title).toBe('CriteriaDoc');
    expect(JSON.stringify(schema)).not.toMatch(/vetkit\.dev|"\$ref":"[^#]/);
  });

  test('authoredCriterion properties and required equal criterion.schema.json minus wordingHash', () => {
    const authored = readSchema('criteria').$defs?.authoredCriterion;
    const criterion = readSchema('criterion');
    expect(authored).toBeDefined();
    expect(authored?.properties).toEqual(withoutWordingHash(criterion.properties));
    expect(authored?.required).toEqual(criterion.required?.filter((k) => k !== 'wordingHash'));
    expect(authored?.oneOf).toEqual(withoutWordingHash(criterion.oneOf));
  });

  test('the template modeline and $schema key both equal the schema $id', () => {
    expect(template.split('\n')[0]).toBe(MODELINE);
    expect(parseYaml(template)).toMatchObject({ $schema: SCHEMA_ID });
    expect(readSchema('criteria').$id).toBe(SCHEMA_ID);
  });

  test('the template validates against criteriaSchema via validateJson after YAML parse', () => {
    expect(generated.criteriaSchema).toBeDefined();
    const result = validateJson(parseYaml(template), criteriaSchema);
    expect(result.ok).toBe(true);
  });

  test('criteriaSchema rejects a criterion missing its instructions', () => {
    expect(generated.criteriaSchema).toBeDefined();
    const result = validateJson({ criteria: [{ id: 'x', type: 'score' }] }, criteriaSchema);
    expect(result.ok).toBe(false);
  });

  test('the template still loads through core loadCriteria with one criterion', async () => {
    const loaded = await loadCriteria(templatePath);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.criteria).toHaveLength(1);
  });

  test('a criteria.yaml edited by core editCriteria keeps the $schema line', () => {
    const parsed = parseCriteriaDocument(template);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(setEnabled(parsed.doc, 'refund-issued', false).ok).toBe(true);
    const out = formatCriteriaDocument(parsed.doc);
    expect(out.split('\n')[0]).toBe(MODELINE);
    expect(parseYaml(out)).toMatchObject({ $schema: SCHEMA_ID });
  });
});
