// `vet init`: scaffold a runnable example project (root DECISION C9): vetkit.config.ts,
// evals/criteria.yaml, evals/cases/example.jsonl, and `.vet/` in .gitignore. The judge
// transport is chosen from the judge-jev presets by which credential env vars are set, so
// no vendor or key value appears here; only env var names reach the written config.
// Nothing is written until every check passes; each file lands via tmp + rename.
import { constants, existsSync } from 'node:fs';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JEV_CREDENTIAL_PRIORITY, JEV_PRESETS, type JevPresetName } from '@vetkit/judge-jev';
import { CEV_ERROR_CODES, VetError } from '@vetkit/spec';
import type { Command } from 'commander';
import { emit, getLogger, isInteractive, prompt, type GlobalOptions } from '../output.ts';

interface InitOptions extends GlobalOptions {
  readonly dir?: string;
  readonly force?: boolean;
}

type Env = Readonly<Record<string, string | undefined>>;

// src/commands/init.ts and dist/commands/init.js both sit two levels below the package root.
const TEMPLATE_DIR = fileURLToPath(new URL('../../templates/', import.meta.url));
const GITIGNORE = '.gitignore';
const CACHE_LINE = '.vet/';

const TARGETS = [
  { path: 'vetkit.config.ts', template: 'vetkit.config.ts.tmpl' },
  { path: 'evals/criteria.yaml', template: 'criteria.yaml' },
  { path: 'evals/cases/example.jsonl', template: 'example.jsonl' },
] as const;

function invalid(message: string): VetError {
  return new VetError(CEV_ERROR_CODES.CONFIG_INVALID, message);
}

function credentialsSet(preset: JevPresetName, env: Env): boolean {
  return JEV_PRESETS[preset].credentials.every((c) => (env[c.name] ?? '') !== '');
}

// The first preset in JEV_CREDENTIAL_PRIORITY whose credentials are all set, else the first
// preset in that order; `matched` lists every preset whose credentials are set.
function chooseTransport(env: Env): { preset: JevPresetName; matched: JevPresetName[] } {
  const matched = JEV_CREDENTIAL_PRIORITY.filter((p) => credentialsSet(p, env));
  const preset = matched[0] ?? JEV_CREDENTIAL_PRIORITY[0];
  if (preset === undefined) throw new Error('judge-jev exports no presets');
  return { preset, matched };
}

// Only env var names are substituted: the bearer token's, and any further credential is the
// endpoint's accountId, read from its env var when the config loads.
function renderConfig(template: string, preset: JevPresetName): string {
  const [key, ...rest] = JEV_PRESETS[preset].credentials;
  const accountId = rest.map((c) => `\n    accountId: process.env['${c.name}'],`).join('');
  return template
    .replaceAll('{{transport}}', preset)
    .replaceAll('{{apiKeyEnv}}', key?.name ?? '')
    .replaceAll('{{accountId}}', accountId);
}

function reportTransport(preset: JevPresetName, matched: readonly JevPresetName[]): void {
  const log = getLogger();
  if (matched.length === 0) {
    const names = JEV_CREDENTIAL_PRIORITY.map((p) =>
      JEV_PRESETS[p].credentials.map((c) => c.name).join(' + '),
    );
    log.warn(
      `no judge credential is set; using the "${preset}" transport. Set one of ${names.join(', ')} before \`vet run\``,
    );
  } else if (matched.length > 1) {
    log.info(`judge credentials found for ${matched.join(', ')}; using "${preset}"`);
  }
}

async function ensureWritable(dir: string): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
    await access(dir, constants.W_OK);
  } catch {
    throw invalid(`cannot write to ${dir}`);
  }
}

async function confirmOverwrite(existing: readonly string[]): Promise<void> {
  const list = existing.join(', ');
  const message = `${list} already exists; pass --force to overwrite`;
  if (!isInteractive()) throw invalid(message);
  const answer = await prompt({
    name: 'overwrite',
    message: `${list} already exists. Overwrite? (y/N)`,
  });
  if (!/^y(es)?$/i.test(answer.trim())) throw invalid(message);
}

async function writeAtomic(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${String(process.pid)}`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, file);
}

// The .gitignore content with `.vet/` appended, or undefined when it already has that line.
async function gitignoreWithCache(file: string): Promise<string | undefined> {
  if (!existsSync(file)) return `${CACHE_LINE}\n`;
  const current = await readFile(file, 'utf8');
  if (current.split(/\r?\n/).some((line) => line.trim() === CACHE_LINE)) return undefined;
  const separator = current === '' || current.endsWith('\n') ? '' : '\n';
  return `${current}${separator}${CACHE_LINE}\n`;
}

/** Writes the example scaffold into `dir`; returns the written paths, relative to `dir`. */
async function scaffoldExample(dir: string, force: boolean, env: Env): Promise<string[]> {
  await ensureWritable(dir);
  const existing = TARGETS.map((t) => t.path).filter((path) => existsSync(join(dir, path)));
  if (existing.length > 0 && !force) await confirmOverwrite(existing);

  const { preset, matched } = chooseTransport(env);
  const contents = await Promise.all(
    TARGETS.map(async ({ path, template }) => {
      const text = await readFile(join(TEMPLATE_DIR, template), 'utf8');
      return { path, text: path === 'vetkit.config.ts' ? renderConfig(text, preset) : text };
    }),
  );
  const gitignore = await gitignoreWithCache(join(dir, GITIGNORE));

  for (const { path, text } of contents) await writeAtomic(join(dir, path), text);
  if (gitignore !== undefined) await writeAtomic(join(dir, GITIGNORE), gitignore);
  reportTransport(preset, matched);
  return [...contents.map((c) => c.path), ...(gitignore === undefined ? [] : [GITIGNORE])];
}

async function initCommand(options: InitOptions): Promise<void> {
  const dir = resolve(options.dir ?? '.');
  const files = await scaffoldExample(dir, options.force === true, process.env);
  emit({ files }, () => [...files.map((file) => `wrote ${file}`), 'next: vet run'].join('\n'));
}

export function registerInit(program: Command): Command {
  return program
    .command('init')
    .description('scaffold a runnable example: config, one criterion and three cases')
    .option('--dir <path>', 'directory to write into (default: the current directory)')
    .option('--force', 'overwrite existing scaffold files')
    .action(async (_options: unknown, command: Command) => {
      await initCommand(command.optsWithGlobals<InitOptions>());
    });
}
