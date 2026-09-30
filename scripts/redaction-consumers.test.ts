import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

// A positive list of writer files that must route their output through the shared sanitizer
// (packages/spec/src/redact.ts). Later writers (report renderer, record writer, step summary)
// extend this list; it is never "only these files".
const WRITERS: readonly { file: string; imports: RegExp }[] = [
  { file: 'packages/cli/src/reporters/junit.ts', imports: /from '@vetkit\/spec'/ },
  { file: 'packages/core/src/run-record.ts', imports: /redact\w*[^;]*from '@vetkit\/spec'/s },
  { file: 'packages/cli/src/logger.ts', imports: /from '\.\/redact\.ts'/ },
  { file: 'packages/cli/src/errors.ts', imports: /from '\.\/redact\.ts'/ },
  { file: 'packages/cli/src/render-events.ts', imports: /from '\.\/redact\.ts'/ },
  {
    file: 'packages/generator-openai-compatible/src/redact.ts',
    imports: /from '@vetkit\/spec'/,
  },
  { file: 'packages/cli/src/redact.ts', imports: /from '@vetkit\/spec'/ },
];

describe('redaction consumers', () => {
  it.each(WRITERS)('$file imports the shared sanitizer', ({ file, imports }) => {
    expect(read(file)).toMatch(imports);
  });

  it.each(['packages/cli/src/reporters/junit.ts', 'packages/core/src/run-record.ts'])(
    '%s calls a redaction function from @vetkit/spec',
    (file) => {
      const source = read(file);
      expect(source).toMatch(/\b(redactSecrets|redactSecretsDeep)\b/);
      expect(source).toMatch(/\bsecretsFrom\b/);
    },
  );

  it('the generator no longer carries its own split/join substitution', () => {
    expect(read('packages/generator-openai-compatible/src/redact.ts')).not.toMatch(
      /\.split\(apiKey\)/,
    );
  });
});

// action/comment.mjs owns its own redactor (a copied contract): its source must apply the
// same length floor and secret-name rule as the shared sanitizer.
describe('action/comment.mjs redactor contract', () => {
  const source = read('action/comment.mjs');

  it('applies the 8-char length floor', () => {
    expect(source).toMatch(/value\.length >= 8/);
  });

  it('uses the shared secret-name rule', () => {
    expect(source).toMatch(/SECRET_NAME = \/KEY\|TOKEN\|SECRET\|PASSWORD\|CREDENTIAL\/i/);
  });
});
