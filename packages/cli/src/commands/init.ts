// `vet init`: scaffold a runnable example project (root DECISION C9): vetkit.config.ts,
// evals/criteria.yaml, evals/cases/example.jsonl, and `.vet/` in .gitignore. The judge
// transport is chosen from the judge-jev presets by which credential env vars are set, so
// no vendor or key value appears here; only env var names reach the written config.
// Nothing is written until every check passes; each file lands via tmp + rename.
//
// `vet init --source <spec> --out <dir>` (bead mol-76a.7) instead resolves the source string
// (sources.ts), the generator and judge (vetkit.config.ts), calls core's generateEvals and
// writes into a temp sibling of --out, renaming it into place only once generation succeeds
// (or replacing --out, under --force) — closing the SIGINT partial-write gap.
import { constants, existsSync } from 'node:fs';
import { access, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  generateEvals,
  type GenerateEvalsInput,
  type GenerateEvalsResult,
  type ResolvedConfig,
} from '@vetkit/core';
import { JEV_CREDENTIAL_PRIORITY, JEV_PRESETS, type JevPresetName } from '@vetkit/judge-jev';
import { CEV_ERROR_CODES, VetError, type GeneratorV1 } from '@vetkit/spec';
import type { Command } from 'commander';
import { loadVetConfig } from '../config-load.ts';
import { generatorFromEndpoint } from '../generators.ts';
import { CEV_EXIT, emit, getLogger, isInteractive, prompt, type GlobalOptions } from '../output.ts';
import { resolveSource } from '../sources.ts';

interface InitOptions extends GlobalOptions {
  readonly dir?: string;
  readonly force?: boolean;
  readonly source?: string;
  readonly out?: string;
}

// A criteria.yaml lint drops error-severity criteria (core's lintCriteria); root design
// (docs/contracts/j2.md "Generation contract") gates the exit code on how many survive.
const MIN_SURVIVING_CRITERIA = 5;

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

// core's ResolvedConfig['generator'] is a GeneratorEndpoint or core's own structural
// GeneratorAdapter stand-in (spec has no GeneratorV1 registry entry yet); an adapter object
// is used as-is here, cast at this boundary, since the two shapes differ structurally
// (root ledger contract 76a.7 #1).
function resolveGenerator(raw: ResolvedConfig['generator']): GeneratorV1 {
  if (raw === undefined) throw invalid('no generator configured');
  if ('specVersion' in raw) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return raw as unknown as GeneratorV1;
  }
  return generatorFromEndpoint(raw, { env: process.env });
}

async function ensureOutAvailable(out: string, force: boolean): Promise<void> {
  if (force || !existsSync(out)) return;
  const entries = await readdir(out);
  if (entries.length > 0) throw invalid(`${out} already exists; pass --force to overwrite`);
}

// Generates into a temp sibling of `out`, so a partial write (a thrown error, a refusal or a
// SIGINT abort) never touches `out` itself; only a report.status 'ok' renames it into place.
async function generateIntoOut(
  input: Omit<GenerateEvalsInput, 'out' | 'overwrite'>,
  out: string,
  force: boolean,
): Promise<GenerateEvalsResult> {
  const tempDir = `${out}.tmp-${String(process.pid)}`;
  let result: GenerateEvalsResult;
  try {
    result = await generateEvals({ ...input, out: tempDir, overwrite: true });
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
  if (result.report.status !== 'ok') {
    await rm(tempDir, { recursive: true, force: true });
    const [issue] = result.report.issues;
    throw new VetError(
      issue?.code ?? CEV_ERROR_CODES.E_IO,
      issue?.message ?? `generation into ${out} was refused`,
    );
  }
  if (force) await rm(out, { recursive: true, force: true });
  await rename(tempDir, out);
  return result;
}

async function generateCommand(options: InitOptions & { source: string }): Promise<void> {
  if (options.out === undefined || options.out === '') {
    throw invalid('--source requires --out <dir>');
  }
  const out = resolve(options.out);
  const force = options.force === true;
  await ensureOutAvailable(out, force);

  const source = resolveSource(options.source);
  const loaded = await loadVetConfig({ cwd: process.cwd() });
  const log = getLogger();
  for (const warning of loaded.warnings) log.warn(warning);
  const generator = resolveGenerator(loaded.config.generator);

  const controller = new AbortController();
  const onSigint = (): void => controller.abort();
  process.on('SIGINT', onSigint);
  let result: GenerateEvalsResult;
  try {
    result = await generateIntoOut(
      { source, generator, judge: loaded.judge, signal: controller.signal },
      out,
      force,
    );
  } finally {
    process.off('SIGINT', onSigint);
  }

  emit(
    result,
    () =>
      `wrote ${String(result.criteria.length)} criteria and ${String(result.cases.length)} cases to ${out}`,
  );
  process.exitCode =
    result.criteria.length >= MIN_SURVIVING_CRITERIA ? CEV_EXIT.OK : CEV_EXIT.FAILED;
}

export function registerInit(program: Command): Command {
  return program
    .command('init')
    .description('scaffold a runnable example, or generate criteria and cases from --source traces')
    .option('--dir <path>', 'directory to write the scaffold into (default: the current directory)')
    .option('--source <spec>', 'traces to generate from: a directory, or jsonl:<dir>')
    .option(
      '--out <dir>',
      'directory to write criteria.yaml and cases/ into (required with --source)',
    )
    .option('--force', 'overwrite existing scaffold or --out files')
    .action(async (_options: unknown, command: Command) => {
      const options = command.optsWithGlobals<InitOptions>();
      if (options.source === undefined) {
        await initCommand(options);
      } else {
        await generateCommand({ ...options, source: options.source });
      }
    });
}
