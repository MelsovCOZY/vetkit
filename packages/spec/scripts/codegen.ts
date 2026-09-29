import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from 'json-schema-to-typescript';

// Sourced from packages/spec/schemas/*.schema.json (JSON Schema 2020-12 IR), this
// script writes packages/spec/src/generated/<name>.ts + index.ts. Determinism: schema
// files are sorted by name, the banner carries no timestamp, and the compile() option
// object never varies between runs.

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = join(PACKAGE_ROOT, '..', '..');
const SCHEMAS_DIR = join(PACKAGE_ROOT, 'schemas');
const GENERATED_DIR = join(PACKAGE_ROOT, 'src', 'generated');

const BANNER_COMMENT = '// generated — do not edit\n';
const EXPECTED_DIALECT = 'https://json-schema.org/draft/2020-12/schema';

type CompileSchema = Parameters<typeof compile>[0];

interface SchemaFile {
  $schema?: unknown;
  $id?: unknown;
  properties?: Record<string, unknown>;
}

function loadSchema(filePath: string): SchemaFile {
  const raw = readFileSync(filePath, 'utf8');
  // Reading the IR's own schema files predates having any schema to validate them
  // against; scripts/ban-raw-json-parse.sh scopes its ban to packages/*/src, not
  // packages/*/scripts, so this is not the safeParseJson chokepoint violation.
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`${filePath}: schema root must be a JSON object`);
  }
  return parsed;
}

function assertSchemaDialect(filePath: string, schema: SchemaFile): void {
  if (schema.$schema !== EXPECTED_DIALECT) {
    throw new Error(
      `${filePath}: expected "$schema": ${JSON.stringify(EXPECTED_DIALECT)}, got ${JSON.stringify(schema.$schema)}`,
    );
  }
  if (typeof schema.$id !== 'string' || schema.$id.length === 0) {
    throw new Error(`${filePath}: missing a non-empty "$id"`);
  }
}

// json-schema-to-typescript silently drops keywords it does not understand; this
// fails loudly instead of shipping a generated type that is missing a property.
function assertEveryPropertyEmitted(filePath: string, schema: SchemaFile, output: string): void {
  for (const key of Object.keys(schema.properties ?? {})) {
    if (!output.includes(key)) {
      throw new Error(
        `${filePath}: generated output is missing property "${key}" — json-schema-to-typescript ` +
          'may have silently dropped an unsupported keyword',
      );
    }
  }
}

function exportedTypeNames(output: string): string[] {
  const names: string[] = [];
  for (const match of output.matchAll(/^export (?:interface|type) (\w+)/gm)) {
    const name = match[1];
    if (name !== undefined) names.push(name);
  }
  return names;
}

// version.schema.json's title is SpecVersionDoc, but the wire
// name consumers ask safeParseJson for is specVersionSchema, not versionSchema.
const SCHEMA_CONSTANT_NAME_OVERRIDES: Record<string, string> = { version: 'specVersion' };

function schemaConstantName(moduleName: string): string {
  return `${SCHEMA_CONSTANT_NAME_OVERRIDES[moduleName] ?? moduleName}Schema`;
}

// Emits packages/spec/src/generated/schemas.ts: one typed JsonSchema constant per
// schemas/*.schema.json file, so consumers can safeParseJson/validateJson against the
// IR without reading packages/spec/schemas/ directly.
function buildSchemasFile(entries: { moduleName: string; schema: SchemaFile }[]): string {
  const lines: string[] = [
    BANNER_COMMENT,
    // criterion.schema.json's "if"/"then" IR keywords land as an object property
    // literally named `then`; oxlint's unicorn/no-thenable rule otherwise flags that
    // as an accidental thenable, which this schema constant is not.
    '/* oxlint-disable unicorn/no-thenable */\n',
    "import type { JsonSchema } from '../json.ts';",
    '',
  ];

  for (const { moduleName, schema } of entries) {
    const constName = schemaConstantName(moduleName);
    lines.push(
      `export const ${constName}: JsonSchema = ${JSON.stringify(schema, null, 2)} as const;`,
      '',
    );
  }

  return `${lines.join('\n')}\n`;
}

async function compileSchema(filePath: string, moduleName: string, schema: SchemaFile) {
  // SchemaFile only names the fields this script reads; json-schema-to-typescript's
  // own JSONSchema4 type covers the full JSON Schema surface, so this is a trusted
  // boundary cast, not a narrowing of validated data.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const output = await compile(schema as CompileSchema, moduleName, {
    bannerComment: BANNER_COMMENT,
    enableConstEnums: false,
    additionalProperties: false,
    cwd: SCHEMAS_DIR,
    style: { singleQuote: true, printWidth: 100 },
  });
  assertEveryPropertyEmitted(filePath, schema, output);
  return output;
}

async function main(): Promise<void> {
  mkdirSync(GENERATED_DIR, { recursive: true });

  const schemaFileNames = readdirSync(SCHEMAS_DIR)
    .filter((name) => name.endsWith('.schema.json'))
    .toSorted();

  const indexLines: string[] = [BANNER_COMMENT];
  const schemaEntries: { moduleName: string; schema: SchemaFile }[] = [];

  for (const fileName of schemaFileNames) {
    const filePath = join(SCHEMAS_DIR, fileName);
    const schema = loadSchema(filePath);
    assertSchemaDialect(filePath, schema);

    const moduleName = basename(fileName, '.schema.json');
    const output = await compileSchema(filePath, moduleName, schema);
    writeFileSync(join(GENERATED_DIR, `${moduleName}.ts`), output);

    for (const typeName of exportedTypeNames(output)) {
      indexLines.push(`export type { ${typeName} } from './${moduleName}.ts';`);
    }

    schemaEntries.push({ moduleName, schema });
  }

  writeFileSync(join(GENERATED_DIR, 'index.ts'), `${indexLines.join('\n')}\n`);
  writeFileSync(join(GENERATED_DIR, 'schemas.ts'), buildSchemasFile(schemaEntries));

  const oxfmtBin = join(REPO_ROOT, 'node_modules', '.bin', 'oxfmt');
  execFileSync(oxfmtBin, [GENERATED_DIR], { cwd: REPO_ROOT, stdio: 'inherit' });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
