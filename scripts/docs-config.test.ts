import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderConfigDocs } from './docs-config.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA_PATH = join(ROOT, 'packages/spec/schemas/config.schema.json');
const DOCS_PATH = join(ROOT, 'docs/configuration.md');
const MANUAL_START = '<!-- manual:start -->';
const MANUAL_END = '<!-- manual:end -->';

// scripts/ may parse JSON directly: the raw JSON.parse ban is scoped to packages/*/src.
const schema: unknown = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));

function manualOf(content: string): string {
  const start = content.indexOf(MANUAL_START);
  const end = content.indexOf(MANUAL_END);
  if (start === -1 || end === -1) return '';
  return content.slice(start + MANUAL_START.length + 1, end - 1);
}

describe('docs-config generator', () => {
  it('renders every top-level property of config.schema.json as a section', () => {
    const out = renderConfigDocs(schema, 'manual text');
    for (const key of [
      'generator',
      'judge',
      'registry',
      'sources',
      'sinks',
      'thresholds',
      'watch',
      'gate',
      'cacheDir',
    ]) {
      expect(out).toContain(`\n### ${key}\n`);
    }
  });

  it('renders every $defs field table', () => {
    const out = renderConfigDocs(schema, 'manual text');
    for (const [title, field] of [
      ['JudgeEndpoint', 'apiKeyEnv'],
      ['GeneratorEndpoint', 'structured'],
      ['AdapterRef', 'specVersion'],
      ['pluginRef', 'id'],
      ['OtelSinkDescriptor', 'headersEnv'],
      ['LangfuseSinkDescriptor', 'secretKeyEnv'],
      ['SinkRef', 'OtelSinkDescriptor'],
    ] as const) {
      const at = out.indexOf(`\n### ${title}\n`);
      expect(at, `missing shape section ${title}`).toBeGreaterThan(-1);
      expect(out.slice(at)).toContain(`\`${field}\``);
    }
  });

  it('docs/configuration.md on disk equals a fresh render', () => {
    const onDisk = readFileSync(DOCS_PATH, 'utf8');
    const fresh = renderConfigDocs(schema, manualOf(onDisk));
    expect(
      onDisk === fresh,
      'docs/configuration.md is stale; run: bun scripts/docs-config.ts',
    ).toBe(true);
  });

  it('preserves the manual region verbatim', () => {
    const edited = '## Mine\n\n| a | b |\n| --- | --- |\n| `x`  | edited   text |\n';
    const out = renderConfigDocs(schema, edited);
    expect(out).toContain(`${MANUAL_START}\n${edited}\n${MANUAL_END}`);
    expect(manualOf(out)).toBe(edited);
  });

  it('starts with the generated banner and is deterministic', () => {
    const a = renderConfigDocs(schema, 'm');
    expect(a.startsWith('<!-- generated')).toBe(true);
    expect(a).toContain('bun scripts/docs-config.ts');
    expect(renderConfigDocs(schema, 'm')).toBe(a);
  });

  it('states the fenced-v1 default for requestFormat', () => {
    const onDisk = readFileSync(DOCS_PATH, 'utf8');
    expect(onDisk).toContain("'fenced-v1' when omitted");
    expect(renderConfigDocs(schema, '')).toContain("'fenced-v1' when omitted");
  });

  it("contains no 'not implemented yet'", () => {
    expect(readFileSync(DOCS_PATH, 'utf8')).not.toContain('not implemented yet');
  });
});
