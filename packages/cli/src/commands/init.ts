// `vet init`: scaffold a runnable example project: vetkit.config.ts,
// evals/criteria.yaml, evals/cases/example.jsonl, and `.vet/` in .gitignore. The judge
// transport is chosen from the judge-jev presets by which credential env vars are set, so
// no vendor or key value appears here; only env var names reach the written config.
// Nothing is written until every check passes; each file lands via tmp + rename.
//
// `vet init --source <spec> --out <dir>` instead resolves the source string
// (sources.ts), the generator and judge (vetkit.config.ts), calls core's generateEvals and
// writes into a temp sibling of --out, renaming it into place only once generation succeeds
// (or replacing --out, under --force) — closing the SIGINT partial-write gap.
import { constants, existsSync } from 'node:fs';
import { access, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  generateEvals,
  type GenerateEvalsInput,
  type GenerateEvalsResult,
  type GenerateReport,
  type ResolvedConfig,
} from '@vetkit/core';
import { JEV_CREDENTIAL_PRIORITY, JEV_PRESETS, type JevPresetName } from '@vetkit/judge-jev';
import {
  CEV_ERROR_CODES,
  VetError,
  type GeneratorV1,
  type NormalizedTrace,
  type SourceV1,
} from '@vetkit/spec';
import type { Command } from 'commander';
import { loadVetConfig } from '../config-load.ts';
import { diagEnabled } from '../diag.ts';
import { generatorFromEndpoint } from '../generators.ts';
import { CEV_EXIT, emit, getLogger, isInteractive, prompt, type GlobalOptions } from '../output.ts';
import { resolveSource, type SourceOptions } from '../sources.ts';
import { buildOtlpSummary } from './init-otlp.ts';

interface InitOptions extends GlobalOptions {
  readonly dir?: string;
  readonly force?: boolean;
  readonly source?: string;
  readonly out?: string;
  // Forwarded to resolveSource as SourceOptions, for otlp::<port>'s
  // receiver mode. Commander hands option values through as strings; the jsonl factory (and
  // any other prefix that ignores SourceOptions) never sees these at all.
  readonly until?: string;
  readonly seconds?: string;
}

// A criteria.yaml lint drops error-severity criteria (core's lintCriteria); the exit code is gated on how many survive.
const MIN_SURVIVING_CRITERIA = 5;

// Explains a too-few-criteria exit 1 (which alone says nothing about why). Names the count, the minimum,
// and the dropped/repaired counts (generateEvals always sets both), so a `--json` caller and
// a stderr reader see the same reason.
function tooFewCriteriaReason(count: number, report: GenerateReport): string {
  const detail: string[] = [];
  if (report.dropped !== undefined) detail.push(`dropped ${String(report.dropped)}`);
  if (report.repaired !== undefined) detail.push(`repaired ${String(report.repaired.length)}`);
  const suffix = detail.length > 0 ? ` (${detail.join(', ')})` : '';
  return `only ${String(count)} criteria survived generation, need at least ${String(MIN_SURVIVING_CRITERIA)}${suffix}`;
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

const DEMO_JUDGE = [
  '  // The judge is the demo judge: it runs offline, returns placeholder verdicts marked',
  "  // transport 'demo', and never gates or locks. To use a real judge, set a key in .env, then",
  '  // run `vet init --force`.',
  '  judge: demoJudge,',
].join('\n');

// Only env var names are substituted: the bearer token's, and any further credential is the
// endpoint's accountId, read from its env var when the config loads.
function realJudge(preset: JevPresetName): string {
  const [key, ...rest] = JEV_PRESETS[preset].credentials;
  const accountId = rest.map((c) => `\n    accountId: process.env['${c.name}'],`).join('');
  return [
    '  // The judge is Jev, reached through the transport below. The key is never stored here:',
    '  // `vet run` reads it from the environment variable named by apiKeyEnv.',
    '  judge: {',
    "    kind: 'typesafe-compatible',",
    `    preset: '${preset}',`,
    `    apiKeyEnv: '${key?.name ?? ''}',${accountId}`,
    '  },',
  ].join('\n');
}

export function renderConfig(template: string, preset: JevPresetName | 'demo'): string {
  const demo = preset === 'demo';
  return template
    .replaceAll('{{imports}}', demo ? 'defineConfig, demoJudge' : 'defineConfig')
    .replaceAll('{{judge}}', demo ? DEMO_JUDGE : realJudge(preset))
    .replaceAll('{{generator}}', '');
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

// Without a vetkit.config.ts in <dir>, `vet run` there would fail CONFIG_INVALID.
// Re-exporting the config `vet init` itself just resolved (by relative import) makes <dir> runnable without inlining
// its generator/judge (an in-process adapter object can't be serialized) or any credential:
// keys still come from the env vars the original config names.
function reexportConfig(configFile: string, out: string): string {
  const rel = relative(out, configFile).split('\\').join('/');
  const specifier = rel.startsWith('.') ? rel : `./${rel}`;
  return [
    '// vetkit.config.ts, written by `vet init --source`: re-exports the',
    '// config `vet init` itself resolved, so `vet run` here uses the same generator and',
    '// judge, with no credential or config duplicated.',
    `export { default } from '${specifier}';`,
    '',
  ].join('\n');
}

function isAdapterObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'specVersion' in value;
}

/**
 * A self-contained vetkit.config.ts equivalent to `config`: judge, generator, sinks, thresholds,
 * watch, gate and cacheDir as a literal, with no import. Endpoint and sink descriptors hold
 * env var names only, so no secret is written. Undefined when the judge, generator or any sink
 * is an in-process adapter object, which cannot be serialized.
 */
export function renderInlineConfig(config: ResolvedConfig): string | undefined {
  const { judge, generator, sinks, thresholds, watch, gate, cacheDir } = config;
  if (isAdapterObject(judge) || isAdapterObject(generator) || sinks.some(isAdapterObject)) {
    return undefined;
  }
  const doc = { judge, generator, sinks, thresholds, watch, gate, cacheDir };
  return [
    '// vetkit.config.ts, written by `vet init --source`: the generator, judge and sinks',
    '// `vet init` resolved, inlined so this folder can move. Keys stay in the env vars named here.',
    `export default ${JSON.stringify(doc, null, 2)};`,
    '',
  ].join('\n');
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
// GeneratorAdapter stand-in; an adapter object is used as-is here, cast at this
// boundary, since the two shapes differ structurally.
function resolveGenerator(raw: ResolvedConfig['generator']): GeneratorV1 {
  if (raw === undefined) throw invalid('no generator configured');
  if ('specVersion' in raw) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return raw as unknown as GeneratorV1;
  }
  return generatorFromEndpoint(raw, { env: process.env });
}

const PRICE_INPUT_ENV = 'CEV_GENERATOR_PRICE_INPUT_PER_MTOK';
const PRICE_OUTPUT_ENV = 'CEV_GENERATOR_PRICE_OUTPUT_PER_MTOK';
const TOKENS_PER_MTOK = 1_000_000;

// What the generator spent over one `vet init`: token totals are null until a call reports usage.
interface GeneratorUsageTotals {
  readonly calls: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly estimatedUsd: number | null;
}

// A non-negative finite number from the named env var, or undefined. A bad value is warned about
// by variable name only, never echoed.
function readPrice(env: Env, name: string, warn: (message: string) => void): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    warn(`${name} is not a non-negative number; ignoring it`);
    return undefined;
  }
  return value;
}

// Counts doGenerate calls and sums the usage each one reports. Prices come only from the env.
function meterGenerator(
  generator: GeneratorV1,
  env: Env,
  warn: (message: string) => void,
): { generator: GeneratorV1; totals: () => GeneratorUsageTotals } {
  const priceIn = readPrice(env, PRICE_INPUT_ENV, warn);
  const priceOut = readPrice(env, PRICE_OUTPUT_ENV, warn);
  let calls = 0;
  let input: number | null = null;
  let output: number | null = null;
  const metered: GeneratorV1 = {
    ...generator,
    async doGenerate(req) {
      calls += 1;
      const result = await generator.doGenerate(req);
      const usage = result.usage;
      if (usage?.inputTokens !== undefined) input = (input ?? 0) + usage.inputTokens;
      if (usage?.outputTokens !== undefined) output = (output ?? 0) + usage.outputTokens;
      return result;
    },
  };
  const totals = (): GeneratorUsageTotals => ({
    calls,
    inputTokens: input,
    outputTokens: output,
    estimatedUsd:
      priceIn === undefined || priceOut === undefined || input === null || output === null
        ? null
        : (input * priceIn + output * priceOut) / TOKENS_PER_MTOK,
  });
  return { generator: metered, totals };
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

// Tees every trace the wrapped source yields into `sink`, as a side effect of the one read
// generateEvals already does — no second pass over the source. Used only to build the otlp:
// summary: buildOtlpSummary needs each trace's dialect and
// tokens, which GenerateEvalsResult does not carry.
function tapSource(source: SourceV1, sink: NormalizedTrace[]): SourceV1 {
  return {
    ...source,
    async *doRead(opts) {
      for await (const trace of source.doRead(opts)) {
        sink.push(trace);
        yield trace;
      }
    },
  };
}

async function generateCommand(options: InitOptions & { source: string }): Promise<void> {
  if (options.out === undefined || options.out === '') {
    throw invalid('--source requires --out <dir>');
  }
  const out = resolve(options.out);
  const force = options.force === true;
  await ensureOutAvailable(out, force);

  const sourceOptions: SourceOptions = {
    ...(options.until === undefined ? {} : { until: Number(options.until) }),
    ...(options.seconds === undefined ? {} : { seconds: Number(options.seconds) }),
  };
  const source = resolveSource(options.source, sourceOptions);
  const collectedTraces: NormalizedTrace[] = [];
  const tappedSource = tapSource(source, collectedTraces);
  const loaded = await loadVetConfig({ cwd: process.cwd() });
  const log = getLogger();
  for (const warning of loaded.warnings) log.warn(warning);
  const meter = meterGenerator(resolveGenerator(loaded.config.generator), process.env, (m) =>
    log.warn(m),
  );
  const generator = meter.generator;

  const controller = new AbortController();
  const onSigint = (): void => controller.abort();
  process.on('SIGINT', onSigint);
  let result: GenerateEvalsResult;
  try {
    result = await generateIntoOut(
      { source: tappedSource, generator, judge: loaded.judge, signal: controller.signal },
      out,
      force,
    );
  } finally {
    process.off('SIGINT', onSigint);
    if (diagEnabled(process.env)) {
      process.stderr.write(`${JSON.stringify({ diag: { generator: meter.totals() } })}\n`);
    }
  }

  const inlined = renderInlineConfig(loaded.config);
  if (inlined === undefined) {
    log.warn(
      `${out}/vetkit.config.ts re-exports ${loaded.configFile} because the judge, generator or a sink is an in-process adapter object that cannot be written out; the folder is not movable`,
    );
  }
  await writeAtomic(
    join(out, 'vetkit.config.ts'),
    inlined ?? reexportConfig(loaded.configFile, out),
  );

  // Only an `otlp:`-sourced run carries a summary (source.id 'otlp/file' or
  // 'otlp/receiver'); every other --source keeps emit()'s existing {criteria, cases, report}
  // document unchanged. Also written to <out>/summary.json, since a
  // caller scripting on the written directory (not stdout) needs it there too.
  const summary = source.id.startsWith('otlp/')
    ? buildOtlpSummary(collectedTraces, result)
    : undefined;
  if (summary !== undefined) {
    await writeAtomic(join(out, 'summary.json'), JSON.stringify(summary));
  }
  const tooFewCriteria = result.criteria.length < MIN_SURVIVING_CRITERIA;
  const reason = tooFewCriteria
    ? tooFewCriteriaReason(result.criteria.length, result.report)
    : undefined;
  if (reason !== undefined) log.error(reason);
  const usage = meter.totals();
  const doc =
    summary === undefined
      ? { ...result, generator: usage }
      : { ...result, generator: usage, summary };
  emit(
    reason === undefined ? doc : { ...doc, reason },
    () =>
      `wrote ${String(result.criteria.length)} criteria and ${String(result.cases.length)} cases to ${out}`,
  );
  process.exitCode = tooFewCriteria ? CEV_EXIT.FAILED : CEV_EXIT.OK;
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
    .option('--until <n>', 'stop a streaming --source (e.g. otlp::<port>) after n traces')
    .option('--seconds <s>', 'stop a streaming --source (e.g. otlp::<port>) after s seconds')
    .addHelpText(
      'after',
      `\nGenerator spend: set ${PRICE_INPUT_ENV} and ${PRICE_OUTPUT_ENV} (USD per million tokens) to get generator.estimatedUsd in --json; both are required.`,
    )
    .action(async (_options: unknown, command: Command) => {
      const options = command.optsWithGlobals<InitOptions>();
      if (options.source === undefined) {
        await initCommand(options);
      } else {
        await generateCommand({ ...options, source: options.source });
      }
    });
}
