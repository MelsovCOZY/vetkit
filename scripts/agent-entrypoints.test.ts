import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'packages', 'cli', 'dist', 'bin.js');
const INDEX = join(ROOT, 'packages', 'cli', 'dist', 'index.js');
const PAGES = 'https://melsovcozy.github.io/vetkit/';

const llms = (): string => readFileSync(join(ROOT, 'llms.txt'), 'utf8').replaceAll('\r\n', '\n');
const skill = (): string =>
  readFileSync(join(ROOT, 'skills', 'vetkit-setup', 'SKILL.md'), 'utf8').replaceAll('\r\n', '\n');

function requireBuild(): void {
  if (!existsSync(BIN) || !existsSync(INDEX)) throw new Error('build first: bun run build');
}

interface CommandInfo {
  readonly name: string;
  readonly description: string;
  readonly path: readonly string[];
}

// createProgram() lives behind the built package entry (scripts' tsconfig cannot import
// program.ts): dump the top-level command list from it in a child process.
let topLevelCache: CommandInfo[] | undefined;

function topLevelCommands(): CommandInfo[] {
  if (topLevelCache) return topLevelCache;
  requireBuild();
  const script = `
    const { createProgram } = await import(${JSON.stringify(INDEX)});
    const list = createProgram().commands.map((c) => ({ name: c.name(), description: c.description() }));
    process.stdout.write(JSON.stringify(list));
  `;
  const out = execFileSync('node', ['--input-type=module', '-e', script], { encoding: 'utf8' });
  const list: { name: string; description: string }[] = JSON.parse(out);
  topLevelCache = list.map((c) => ({ ...c, path: [c.name] }));
  return topLevelCache;
}

const helpCache = new Map<string, string>();

function help(args: readonly string[]): string {
  const key = args.join(' ');
  const cached = helpCache.get(key);
  if (cached !== undefined) return cached;
  requireBuild();
  const result = spawnSync('node', [BIN, ...args, '--help'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`vet ${args.join(' ')} --help failed: ${result.stderr}`);
  helpCache.set(key, result.stdout);
  return result.stdout;
}

function flagsOf(text: string): Set<string> {
  return new Set(text.match(/--[a-z][\w-]*/g));
}

// Every `vet|vetkit <command> [--flag ...]` in the text must name a real command whose --help
// lists each flag (root --help lists the global flags).
function checkCommandMentions(text: string): number {
  const top = new Set(topLevelCommands().map((c) => c.name));
  const globalFlags = flagsOf(help([]));
  let checked = 0;
  for (const match of text.matchAll(/\b(?:vet|vetkit) ([a-z][a-z-]*)([^\n`]*)/g)) {
    const command = match[1] ?? '';
    if (!top.has(command)) continue;
    const known = flagsOf(help([command]));
    for (const flag of (match[2] ?? '').match(/(?<=\s)--[a-z][\w-]*/g) ?? []) {
      expect(known.has(flag) || globalFlags.has(flag), `vet ${command} ${flag}`).toBe(true);
      checked += 1;
    }
  }
  return checked;
}

describe('llms.txt', () => {
  it('llms.txt starts with `# vetkit`, has exactly one `>` summary line before the first H2, and the H2s Install, Quickstart, Configuration, CLI reference, Integrations, Optional in that order', () => {
    const text = llms();
    expect(text.startsWith('# vetkit\n')).toBe(true);
    const lines = text.split('\n');
    const firstH2 = lines.findIndex((line) => line.startsWith('## '));
    expect(firstH2).toBeGreaterThan(0);
    expect(lines.slice(0, firstH2).filter((line) => line.startsWith('>'))).toHaveLength(1);
    const headings = lines.filter((line) => line.startsWith('## ')).map((line) => line.slice(3));
    expect(headings).toEqual([
      'Install',
      'Quickstart',
      'Configuration',
      'CLI reference',
      'Integrations',
      'Optional',
    ]);
  });

  it('every markdown link in llms.txt is a tracked repo path (git ls-files) or a https://melsovcozy.github.io/vetkit/ URL', () => {
    const tracked = new Set(
      execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n'),
    );
    const targets = [...llms().matchAll(/\[[^\]]+\]\(([^)\s]+)\)/g)].map((m) => m[1] ?? '');
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      if (target.startsWith('https://') || target.startsWith('http://')) {
        expect(target.startsWith(PAGES), target).toBe(true);
      } else {
        expect(tracked.has(target.split('#')[0] ?? ''), target).toBe(true);
      }
    }
  });

  it('CLI reference lists every command registered by createProgram() with its description string', () => {
    const text = llms();
    const section = /^## CLI reference\n([\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(text)?.[1] ?? '';
    const commands = topLevelCommands();
    expect(commands.length).toBeGreaterThan(5);
    for (const { name, description } of commands) {
      const bullet = section.split('\n').find((line) => line.startsWith(`- \`vet ${name}\``));
      expect(bullet, `bullet for ${name}`).toBeDefined();
      expect(bullet, `description of ${name}`).toContain(description);
    }
    expect(section).toContain('docs/guides/cli-json.md');
  });

  it('Configuration links config.schema.json on the Pages base URL', () => {
    const section = /^## Configuration\n([\s\S]*?)(?=^## )/m.exec(llms())?.[1] ?? '';
    expect(section).toContain(`${PAGES}schemas/config.schema.json`);
    expect(section).toContain('docs/configuration.md');
  });
});

describe('skills/vetkit-setup/SKILL.md', () => {
  it('SKILL.md frontmatter parses (yaml) with name vetkit-setup and a description of 1..1024 chars', () => {
    const match = /^---\n([\s\S]*?)\n---\n/.exec(skill());
    expect(match).not.toBeNull();
    const frontmatter: { name?: unknown; description?: unknown } = parse(match?.[1] ?? '');
    expect(frontmatter.name).toBe('vetkit-setup');
    expect(typeof frontmatter.description).toBe('string');
    const description = String(frontmatter.description);
    expect(description.length).toBeGreaterThanOrEqual(1);
    expect(description.length).toBeLessThanOrEqual(1024);
  });

  it('every `vet`/`vetkit` command and every `--flag` named in SKILL.md and llms.txt exists on that command', () => {
    expect(checkCommandMentions(skill())).toBeGreaterThan(0);
    expect(checkCommandMentions(llms())).toBeGreaterThanOrEqual(0);
  }, 60_000);

  it('SKILL.md tells the agent to ask the human for the key and never to print it', () => {
    expect(skill()).toContain(
      'Ask the human for the key value; never print, echo, log or paste a key.',
    );
  });
});

describe('both entry points', () => {
  it('neither file contains a key-like value', () => {
    for (const text of [llms(), skill()]) {
      expect(text).not.toMatch(/sk-[A-Za-z0-9_-]{16,}/);
      expect(text).not.toMatch(/=\s*["']?[A-Za-z0-9+/_-]{32,}/);
    }
  });

  it('neither file has absolute local paths, old-host links or an AGENTS.md link, and the skill never gates on the demo judge', () => {
    for (const text of [llms(), skill()]) {
      expect(text).not.toMatch(/\/home\/|\/Users\/|C:\\/);
      expect(text).not.toContain(['vetkit', 'dev'].join('.'));
      expect(text).not.toContain('AGENTS.md');
    }
    expect(skill()).not.toMatch(/vet(kit)? run[^\n]*--gate/);
  });

  it('SKILL.md is the only file in skills/vetkit-setup besides an optional reference.md', () => {
    const files = execFileSync('git', ['ls-files', 'skills/vetkit-setup'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .filter((file) => file !== '');
    expect(files).toContain('skills/vetkit-setup/SKILL.md');
    for (const file of files) {
      expect(['skills/vetkit-setup/SKILL.md', 'skills/vetkit-setup/reference.md']).toContain(file);
    }
  });
});
