import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCHEMA_VERSIONS } from '../packages/core/src/schema-version.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLES = join(ROOT, 'examples');

// Every shipped example's criteria.yaml, as examples/<name>/evals/criteria.yaml.
const exampleCriteria = readdirSync(EXAMPLES, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join('examples', entry.name, 'evals', 'criteria.yaml'))
  .filter((path) => existsSync(join(ROOT, path)));

// The first line that is neither blank nor a comment: the line the document's first key sits on.
function firstKeyLine(text: string): string | undefined {
  return text.split('\n').find((line) => line.trim() !== '' && !line.trimStart().startsWith('#'));
}

// A criteria.yaml vetkit ships carries the schema version it was written for, like one the CLI
// writes, so copying an example into a project leaves `vet migrate --check` nothing to stamp.
describe('the shipped examples', () => {
  it('ship at least one evals/criteria.yaml', () => {
    expect(exampleCriteria.length).toBeGreaterThan(0);
  });

  it.each(exampleCriteria)('%s carries schemaVersion: 1 as its first key', (path) => {
    const text = readFileSync(join(ROOT, path), 'utf8');
    expect(firstKeyLine(text)).toBe(`schemaVersion: ${String(SCHEMA_VERSIONS.criteria)}`);
  });
});
