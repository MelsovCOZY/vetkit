import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { describe, expect, test } from 'vitest';
import { createProgram } from './program.ts';
import { SINK_DESCRIPTOR_KINDS } from './sinks.ts';

const DOCS_DIR = fileURLToPath(new URL('../../../docs/', import.meta.url));
const SCHEMA_PATH = fileURLToPath(
  new URL('../../../packages/spec/schemas/config.schema.json', import.meta.url),
);

// Global options every command accepts (program.ts registers them on the root command).
const GLOBAL_FLAGS = ['--json', '--quiet', '--verbose', '--no-color', '--color', '--version'];

// Doc file -> the commands it documents. A doc naming a flag of another command needs the
// mapping extended here. configuration.md and INDEX.md are exempt: configuration.md is generated
// from the config schema and names no command flags, INDEX.md is a local index.
const DOC_COMMANDS: Readonly<Record<string, readonly string[]>> = {
  'watch.md': ['watch'],
  'sinks.md': ['run', 'watch'],
};
const EXEMPT_DOCS = ['configuration.md', 'INDEX.md'];

function read(name: string): string {
  return readFileSync(`${DOCS_DIR}${name}`, 'utf8');
}

function flagsOf(command: Command): Set<string> {
  const flags = new Set<string>();
  for (const option of command.options) if (option.long !== undefined) flags.add(option.long);
  return flags;
}

function docFlags(text: string): string[] {
  return [...new Set(text.replace(/<!--[\s\S]*?-->/g, '').match(/--[a-z][a-z0-9-]*/g) ?? [])];
}

function unknownFlags(doc: string, commands: readonly string[]): string[] {
  const program = createProgram();
  const known = new Set(GLOBAL_FLAGS);
  for (const name of commands) {
    const command = program.commands.find((c) => c.name() === name);
    if (command === undefined) throw new Error(`no command "${name}" for ${doc}`);
    for (const flag of flagsOf(command)) known.add(flag);
  }
  return docFlags(read(doc)).filter((flag) => !known.has(flag));
}

interface SchemaShape {
  $defs: Record<string, { properties: { kind: { const: string } } }>;
}

describe('docs flags', () => {
  test('docs/watch.md names only flags that exist on vet watch or globally', () => {
    expect(unknownFlags('watch.md', ['watch'])).toEqual([]);
  });

  test('docs/sinks.md names only flags that exist on vet run or vet watch', () => {
    expect(unknownFlags('sinks.md', ['run', 'watch'])).toEqual([]);
  });

  test('docs/watch.md documents --sample, --sink and --config on vet watch', () => {
    const text = read('watch.md');
    for (const flag of ['--sample <rate>', '--sink [names]', '--config <path>']) {
      expect(text).toContain(`\`${flag}\``);
    }
    expect(text).toContain('watch.sampleRate from the config');
    expect(text).not.toContain('--upstream-sample-rate');
    expect(text).not.toContain('against your OTel collector');
  });

  test('docs/sinks.md shows how to enable a sink', () => {
    const text = read('sinks.md');
    expect(text).toContain('## Enabling a sink');
    expect(text).toContain('vet run --sink otel');
    expect(text).toContain('vet watch --sink langfuse');
    expect(text).toContain("kind: 'otel'");
    expect(text).not.toMatch(/--sink\s+otel\/logs/);
  });

  test('every --sink <name> in docs names a registered descriptor kind', () => {
    const kinds: readonly string[] = SINK_DESCRIPTOR_KINDS;
    for (const file of readdirSync(DOCS_DIR).filter((f) => f.endsWith('.md'))) {
      for (const match of read(file).matchAll(/--sink\s+([a-z][a-z0-9/-]*)/g)) {
        expect(kinds, `${file}: --sink ${match[1]}`).toContain(match[1]);
      }
    }
  });

  test("SINK_DESCRIPTOR_KINDS matches the kinds the schema's sinkRef accepts", () => {
    // scripts and tests may parse trusted repo JSON directly; the ban is on packages/*/src.
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as SchemaShape;
    const fromSchema = [
      schema.$defs['otelSinkDescriptor']?.properties.kind.const,
      schema.$defs['langfuseSinkDescriptor']?.properties.kind.const,
    ];
    expect([...SINK_DESCRIPTOR_KINDS]).toEqual(fromSchema);
  });

  test('the mapping covers every tracked docs/*.md that mentions a --flag', () => {
    for (const file of readdirSync(DOCS_DIR).filter((f) => f.endsWith('.md'))) {
      if (EXEMPT_DOCS.includes(file)) continue;
      if (docFlags(read(file)).length === 0) continue;
      expect(Object.keys(DOC_COMMANDS), `${file} mentions a --flag but is unmapped`).toContain(
        file,
      );
    }
  });
});
