import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderJsonShapesMarkdown } from '../packages/cli/src/json-shapes.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GUIDES = join(ROOT, 'docs', 'guides');
const EXAMPLE = join(ROOT, 'examples', 'ai-sdk-otlp');
const BIN = join(ROOT, 'packages', 'cli', 'dist', 'bin.js');

function read(path: string): string {
  return readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
}

const aiSdkGuide = (): string => read(join(GUIDES, 'ai-sdk-telemetry.md'));
const otlpGuide = (): string => read(join(GUIDES, 'otlp-http-json.md'));

function fencedBlocks(markdown: string, lang: string): string[] {
  const blocks: string[] = [];
  const pattern = new RegExp(`^\`\`\`${lang}\\n([\\s\\S]*?)^\`\`\`$`, 'gm');
  for (const match of markdown.matchAll(pattern)) blocks.push((match[1] ?? '').trimEnd());
  return blocks;
}

function help(args: readonly string[]): string {
  if (!existsSync(BIN)) throw new Error(`build first: ${BIN} is missing (bun run build)`);
  const result = spawnSync('node', [BIN, ...args, '--help'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`vet ${args.join(' ')} --help failed: ${result.stderr}`);
  return result.stdout;
}

function commandNames(helpText: string): string[] {
  const section =
    /^Commands:\n([\s\S]*?)(?:\n\n|\nExit codes:|$(?![\s\S]))/m.exec(helpText)?.[1] ?? '';
  return section
    .split('\n')
    .map((line) => /^ {2}([a-z][a-z-]*)/.exec(line)?.[1])
    .filter((name): name is string => name !== undefined);
}

describe('guides', () => {
  it('both guides state the 415 json-only response and name application/json', () => {
    for (const guide of [aiSdkGuide(), otlpGuide()]) {
      expect(guide).toContain('415');
      expect(guide).toContain('{"error":"json only"}');
      expect(guide).toContain('application/json');
    }
  });

  it('both guides name OTEL_EXPORTER_OTLP_PROTOCOL=http/json and the -http exporter, never -proto or -grpc as the recommended path', () => {
    for (const guide of [aiSdkGuide(), otlpGuide()]) {
      expect(guide).toContain('OTEL_EXPORTER_OTLP_PROTOCOL=http/json');
      expect(guide).toContain('@opentelemetry/exporter-trace-otlp-http');
      for (const line of guide.split('\n')) {
        if (/exporter-trace-otlp-(proto|grpc)/.test(line)) {
          expect(line, 'a -proto/-grpc mention must say it does not work').toMatch(
            /never|not|415|reject|unsupported/i,
          );
        }
      }
      expect(guide).not.toMatch(/OTEL_EXPORTER_OTLP_PROTOCOL=(http\/protobuf|grpc)/);
    }
  });

  it('the AI SDK guide names experimental_telemetry, recordInputs, recordOutputs and vet watch / vet init --source otlp::<port>', () => {
    const guide = aiSdkGuide();
    for (const needle of [
      'experimental_telemetry',
      'recordInputs',
      'recordOutputs',
      'vet watch',
      'vet init --source otlp::',
    ]) {
      expect(guide).toContain(needle);
    }
  });

  it('every fenced ts block in the AI SDK guide equals a file in examples/ai-sdk-otlp (no drift)', () => {
    const files = readdirSync(EXAMPLE)
      .filter((name) => name.endsWith('.ts'))
      .map((name) => read(join(EXAMPLE, name)).trimEnd());
    const blocks = fencedBlocks(aiSdkGuide(), 'ts');
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) expect(files).toContain(block);
  });

  it('every `vet <cmd> --flag` mentioned in the guides exists on that command', () => {
    const top = commandNames(help([]));
    const globalFlags = new Set(help([]).match(/--[a-z][\w-]*/g));
    let checked = 0;
    for (const guide of [aiSdkGuide(), otlpGuide()]) {
      for (const match of guide.matchAll(/\bvet ([a-z][a-z-]*)([^\n`]*)/g)) {
        const command = match[1] ?? '';
        if (!top.includes(command)) continue;
        const flags = (match[2] ?? '').match(/(?<=\s)--[a-z][\w-]*/g) ?? [];
        const known = new Set(help([command]).match(/--[a-z][\w-]*/g));
        for (const flag of flags) {
          expect(known.has(flag) || globalFlags.has(flag), `vet ${command} ${flag}`).toBe(true);
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('docs/guides/cli-json.md equals renderJsonShapesMarkdown() (freshness)', () => {
    expect(read(join(GUIDES, 'cli-json.md'))).toBe(renderJsonShapesMarkdown());
  });

  it('the guides hold no key value and link no vetkit.dev page', () => {
    for (const guide of [aiSdkGuide(), otlpGuide()]) {
      expect(guide).not.toMatch(/sk-[A-Za-z0-9_-]{16,}/);
      expect(guide).not.toContain('vetkit.dev');
    }
  });
});
