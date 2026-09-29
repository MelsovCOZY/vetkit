import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { configSchema } from './index.ts';
import { safeParseJson, validateJson } from './json.ts';

const SCHEMAS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'schemas');

const judge = { kind: 'x', apiKeyEnv: 'K', preset: 'p' };
const ep = {
  kind: 'openai-compatible',
  baseURL: 'https://gen.example/v1',
  apiKeyEnv: 'MY_GEN_KEY',
  model: 'gen-model',
};

describe('config.schema.json judgeEndpoint.requestFormat', () => {
  test.each(['raw', 'fenced-v1'])('accepts requestFormat %s', (requestFormat) => {
    expect(validateJson({ judge: { ...judge, requestFormat } }, configSchema).ok).toBe(true);
  });

  test('accepts a judge endpoint without requestFormat', () => {
    expect(validateJson({ judge }, configSchema).ok).toBe(true);
  });

  test.each(['fenced', 'RAW', '', 1])('rejects requestFormat %s', (requestFormat) => {
    expect(validateJson({ judge: { ...judge, requestFormat } }, configSchema).ok).toBe(false);
  });
});

describe('config.schema.json generatorEndpoint.structured', () => {
  test.each(['json_schema', 'json_object', 'prompt'])('accepts structured %s', (structured) => {
    const result = validateJson({ judge, generator: { ...ep, structured } }, configSchema);
    expect(result.ok).toBe(true);
  });

  test('accepts a generator endpoint without structured', () => {
    expect(validateJson({ judge, generator: ep }, configSchema).ok).toBe(true);
  });

  test.each(['tool', 'JSON_SCHEMA', '', 1])('rejects structured %s', (structured) => {
    const result = validateJson({ judge, generator: { ...ep, structured } }, configSchema);
    expect(result.ok).toBe(false);
  });

  test('configSchema deep-equals schemas/config.schema.json', () => {
    const raw = readFileSync(join(SCHEMAS_DIR, 'config.schema.json'), 'utf8');
    const result = safeParseJson<unknown>(raw, {});
    if (!result.ok) throw new Error('failed to parse config.schema.json');
    expect(configSchema).toEqual(result.value);
  });
});
