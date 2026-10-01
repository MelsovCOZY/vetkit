import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

// One published page per integration: the only prose for vitest, promptfoo, the action and
// Langfuse used to live in README files the docs site does not stage. Each page is checked
// against the CLI help, the config schema and action.yml so it cannot claim a flag, key or
// input that does not exist.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GUIDES = join(ROOT, 'docs', 'guides');
const BIN = join(ROOT, 'packages', 'cli', 'dist', 'bin.js');
const SCHEMA_PATH = join(ROOT, 'packages/spec/schemas/config.schema.json');

interface Guide {
  readonly file: string;
  readonly integration: RegExp;
  /** The README the page must link to, relative to docs/guides. */
  readonly link: string;
  /** The README that links back to the page; the Langfuse page has no example to link from. */
  readonly backlinkFrom?: string;
}

const PAGES: readonly Guide[] = [
  {
    file: 'vitest.md',
    integration: /vitest/i,
    link: '../../examples/vitest/README.md',
    backlinkFrom: 'examples/vitest/README.md',
  },
  {
    file: 'promptfoo.md',
    integration: /promptfoo/i,
    link: '../../examples/promptfoo/README.md',
    backlinkFrom: 'examples/promptfoo/README.md',
  },
  {
    file: 'github-action.md',
    integration: /GitHub Action/,
    link: '../../action/README.md',
    backlinkFrom: 'action/README.md',
  },
  {
    file: 'langfuse.md',
    integration: /Langfuse/,
    link: '../sinks.md',
  },
];

function read(path: string): string {
  return readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
}

const guide = (file: string): string => read(join(GUIDES, file));

function fencedBlocks(markdown: string, lang: string): string[] {
  const blocks: string[] = [];
  const pattern = new RegExp(`^\`\`\`${lang}\\n([\\s\\S]*?)^\`\`\`$`, 'gm');
  for (const match of markdown.matchAll(pattern)) blocks.push(match[1] ?? '');
  return blocks;
}

const helpCache = new Map<string, string>();

function help(args: readonly string[]): string {
  const key = args.join(' ');
  const cached = helpCache.get(key);
  if (cached !== undefined) return cached;
  if (!existsSync(BIN)) throw new Error(`build first: ${BIN} is missing (bun run build)`);
  const result = spawnSync('node', [BIN, ...args, '--help'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`vet ${args.join(' ')} --help failed: ${result.stderr}`);
  helpCache.set(key, result.stdout);
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

describe('integration guides', () => {
  it.each(PAGES)(
    '$file opens with an H1 naming the integration and LLM evals, then a paragraph, then prerequisites',
    ({ file, integration }) => {
      const text = guide(file);
      const h1 = /^# (.+)$/m.exec(text)?.[1] ?? '';
      expect(h1).toContain('LLM evals');
      expect(h1).toMatch(integration);
      const afterH1 = text.slice(text.indexOf('\n', text.indexOf('# ')) + 1).trimStart();
      const firstParagraph = afterH1.split('\n\n')[0] ?? '';
      expect(firstParagraph.startsWith('#'), 'a paragraph must follow the H1').toBe(false);
      expect(firstParagraph.length).toBeGreaterThan(40);
      expect(text).toMatch(/^## Prerequisites$/m);
    },
  );

  it.each(PAGES)('$file links to $link', ({ file, link }) => {
    expect(guide(file)).toContain(`](${link})`);
  });

  it.each(PAGES.filter((page) => page.backlinkFrom !== undefined))(
    '$backlinkFrom links to the guide on exactly one line',
    ({ file, backlinkFrom }) => {
      const lines = read(join(ROOT, backlinkFrom ?? '')).split('\n');
      const linking = lines.filter(
        (line) => line.includes(`docs/guides/${file}`) || line.includes(`guides/${file}`),
      );
      expect(linking, `${backlinkFrom} -> ${file}`).toHaveLength(1);
    },
  );

  it('every `vet <cmd> --flag` in the guides exists on that command', () => {
    const top = commandNames(help([]));
    const globalFlags = new Set(help([]).match(/--[a-z][\w-]*/g));
    let checked = 0;
    for (const { file } of PAGES) {
      for (const match of guide(file).matchAll(/\bvet ([a-z][a-z-]*)([^\n`]*)/g)) {
        const command = match[1] ?? '';
        if (!top.includes(command)) continue;
        const flags = (match[2] ?? '').match(/(?<=\s)--[a-z][\w-]*/g) ?? [];
        const known = new Set(help([command]).match(/--[a-z][\w-]*/g));
        for (const flag of flags) {
          expect(known.has(flag) || globalFlags.has(flag), `${file}: vet ${command} ${flag}`).toBe(
            true,
          );
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  }, 60_000);

  it('the Langfuse sink descriptor in the guide uses only keys the config schema defines', () => {
    // scripts/ may parse JSON directly: the raw JSON.parse ban is scoped to packages/*/src.
    const schema: {
      $defs: { langfuseSinkDescriptor: { properties: Record<string, unknown> } };
    } = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
    const allowed = new Set(Object.keys(schema.$defs.langfuseSinkDescriptor.properties));
    const blocks = fencedBlocks(guide('langfuse.md'), 'ts').filter((block) =>
      block.includes("kind: 'langfuse'"),
    );
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      const keys = [...block.matchAll(/^\s*(\w+):/gm)].map((match) => match[1] ?? '');
      expect(keys).toContain('kind');
      for (const key of keys) {
        if (key === 'sinks') continue;
        expect(allowed.has(key), `langfuse descriptor key ${key}`).toBe(true);
      }
    }
    expect(guide('langfuse.md')).toContain('--sink langfuse');
  });

  it('the action guide uses the published action and only inputs action.yml declares', () => {
    const text = guide('github-action.md');
    expect(text).toContain('uses: MelsovCOZY/vetkit@v0');
    const action: { inputs: Record<string, unknown> } = parse(read(join(ROOT, 'action.yml')));
    const declared = new Set(Object.keys(action.inputs));
    const workflows = fencedBlocks(text, 'yaml');
    expect(workflows.length).toBeGreaterThan(0);
    for (const workflow of workflows) {
      const parsed: {
        jobs: Record<string, { steps: { uses?: string; with?: Record<string, unknown> }[] }>;
      } = parse(workflow);
      const steps = Object.values(parsed.jobs).flatMap((job) => job.steps);
      const ours = steps.filter((step) => step.uses?.startsWith('MelsovCOZY/vetkit@'));
      expect(ours.length).toBeGreaterThan(0);
      for (const step of ours) {
        for (const input of Object.keys(step.with ?? {})) {
          expect(declared.has(input), `action input ${input}`).toBe(true);
        }
      }
    }
  });

  it('the guides hold no key value and link no page on the old host', () => {
    for (const { file } of PAGES) {
      const text = guide(file);
      expect(text).not.toMatch(/sk-[A-Za-z0-9_-]{16,}/);
      expect(text).not.toContain(['vetkit', 'dev'].join('.'));
    }
  });

  it('the four pages are tracked, so the site build stages them', () => {
    const tracked = execFileSync('git', ['ls-files', 'docs/guides'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .filter((path) => path !== '');
    for (const { file } of PAGES) expect(tracked).toContain(`docs/guides/${file}`);
  });
});
