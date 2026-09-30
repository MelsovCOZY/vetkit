// The CLI's one config loader used by `vet run` and reused by
// later commands. Discovery walks up to the nearest package.json and Node's own import() executes the file; core resolveConfig validates it and
// applies defaults; the judge is then built here, in the CLI, never in core: an adapter object
// passes through, and a {kind: 'typesafe-compatible', …} descriptor becomes createJevJudge with
// its key read from the env var the config names.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readEnvName, resolveConfig, type ResolvedConfig } from '@vetkit/core';
import {
  createJevJudgeFromEndpoint,
  JEV_PRESETS,
  type JevProviderOptions,
} from '@vetkit/judge-jev';
import {
  CEV_ERROR_CODES,
  safeParseJson,
  VetError,
  type JudgeEndpoint,
  type JudgeV1,
} from '@vetkit/spec';
import { diagEnabled, withJudgeDiag } from './diag.ts';
import { applyEnvFiles, type EnvFileReport } from './env-file.ts';
import { getLogger } from './output.ts';

type Env = Record<string, string | undefined>;

export interface LoadVetConfigOptions {
  /** Directory searched for vetkit.config.* and against which configPath resolves. */
  readonly cwd: string;
  /** Explicit config file (`--config`); skips discovery. */
  readonly configPath?: string;
  /** Where descriptor apiKeyEnv names are read and where .env files are merged. Defaults to process.env. */
  readonly env?: Env;
  /**
   * False resolves the config for an offline command (estimate, doctor --config): an unset
   * apiKeyEnv does not throw but is listed in missingCredentials, and that judge's doJudge
   * rejects CONFIG_INVALID before any network call. Defaults to true.
   */
  readonly requireCredentials?: boolean;
  /**
   * A file already found by resolveConfigFile: discovery is skipped and exactly this file is
   * imported. Wins over configPath when both are given.
   */
  readonly resolved?: ResolvedConfigFile;
}

export interface ResolvedConfigFile {
  /** Absolute path of the config file. */
  readonly configFile: string;
  /** The config file's directory. */
  readonly rootDir: string;
}

/** Every project path a command needs, absolute, derived once from the config's directory. */
export interface ProjectPaths {
  readonly rootDir: string;
  /** `<rootDir>/evals` when it exists, else `<rootDir>` (`vet init --out` writes flat). */
  readonly dataDir: string;
  readonly criteria: string;
  readonly cases: string;
  readonly labels: string;
  readonly gauntlet: string;
  readonly lock: string;
  readonly vitestOut: string;
  readonly cacheDir: string;
}

export interface LoadedVetConfig {
  readonly config: ResolvedConfig;
  /** The judge, ready to call: the config's adapter object or one built from its descriptor. */
  readonly judge: JudgeV1;
  readonly warnings: readonly string[];
  /** Env var names the judge needs but that are unset (only with requireCredentials:false). */
  readonly missingCredentials: readonly string[];
  /** Absolute path of the loaded config file. */
  readonly configFile: string;
  /** The config file's directory: project-relative paths resolve against it. */
  readonly rootDir: string;
  readonly paths: ProjectPaths;
  /** One report per .env file found next to the config: names applied, never values. */
  readonly envFiles: readonly EnvFileReport[];
  /** The base URL the descriptor judge talks to (override > config > preset); undefined for an adapter. */
  readonly judgeBaseURL: string | undefined;
}

const CANDIDATES = ['ts', 'mts', 'js', 'mjs', 'json'].map((ext) => `vetkit.config.${ext}`);
const EXTENSIONS = '{ts,mts,js,mjs,json}';
const LOCK_FILE = 'criteria.lock.json';
const UNSUPPORTED_SYNTAX_CODES = new Set([
  'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX',
  'ERR_INVALID_TYPESCRIPT_SYNTAX',
]);
const JUDGE_KIND = 'typesafe-compatible';
/**
 * A generic override of the judge transport's base URL for this process, so a test (or an
 * operator) can force a judge failure without touching config. Named CEV_ (no vendor) since it
 * applies to any typesafe-compatible endpoint, not one preset. Exported so a command that
 * reports the override (doctor) names the same variable the loader reads.
 */
export const JUDGE_BASE_URL_ENV = 'CEV_JUDGE_BASE_URL';

function isProviderOptions(value: unknown): value is JevProviderOptions {
  if (typeof value !== 'object' || value === null || !('gateway' in value)) return false;
  const gateway: unknown = value.gateway;
  return (
    typeof gateway === 'object' &&
    gateway !== null &&
    'zeroDataRetention' in gateway &&
    typeof gateway.zeroDataRetention === 'boolean' &&
    'only' in gateway &&
    Array.isArray(gateway.only) &&
    gateway.only.every((item: unknown) => typeof item === 'string')
  );
}

function invalid(message: string): VetError {
  return new VetError(CEV_ERROR_CODES.CONFIG_INVALID, message);
}

function missingKeyMessage(keyEnv: string): string {
  return `judge credential ${keyEnv} is not set; add ${keyEnv}=... to .env or export it`;
}

// Stands in for an unset key so the judge (and its capabilities) can still be built; the
// judge wrapping it is never allowed to send a request.
const UNSET_KEY_PLACEHOLDER = 'vetkit-unset-credential';

// A judge whose key is unset: same identity and capabilities, but doJudge rejects before
// the transport runs, so the placeholder key can never reach the network.
function offlineJudge(judge: JudgeV1, keyEnv: string): JudgeV1 {
  return {
    specVersion: judge.specVersion,
    id: judge.id,
    capabilities: judge.capabilities,
    doJudge: () => Promise.reject(invalid(missingKeyMessage(keyEnv))),
  };
}

function judgeFromEndpoint(endpoint: JudgeEndpoint, apiKey: string): JudgeV1 {
  if (endpoint.kind !== JUDGE_KIND) {
    throw invalid(`judge kind "${endpoint.kind}" is not supported; use "${JUDGE_KIND}"`);
  }
  const providerOptions = endpoint.providerOptions;
  if (providerOptions !== undefined && !isProviderOptions(providerOptions)) {
    throw invalid('judge providerOptions must be { gateway: { zeroDataRetention, only } }');
  }
  const extra = { apiKey, ...(providerOptions === undefined ? {} : { providerOptions }) };
  return createJevJudgeFromEndpoint(endpoint, extra);
}

// Walks from cwd upward; the directory holding package.json is the last one searched.
function walk(cwd: string): { readonly file: string | undefined; readonly stopDir: string } {
  let dir = resolve(cwd);
  for (;;) {
    for (const name of CANDIDATES) {
      const file = join(dir, name);
      if (existsSync(file)) return { file, stopDir: dir };
    }
    const parent = dirname(dir);
    if (existsSync(join(dir, 'package.json')) || parent === dir) {
      return { file: undefined, stopDir: dir };
    }
    dir = parent;
  }
}

/** The nearest vetkit.config.* from cwd up to the nearest package.json, or undefined. */
export function findConfigFile(cwd: string): string | undefined {
  return walk(cwd).file;
}

/** Locates the config file without importing it; throws CONFIG_INVALID when there is none. */
export function resolveConfigFile(options: {
  readonly cwd: string;
  readonly configPath?: string;
}): ResolvedConfigFile {
  if (options.configPath !== undefined) {
    const configFile = resolve(options.cwd, options.configPath);
    if (!existsSync(configFile))
      throw invalid(`no vetkit config found at ${configFile}; run: vet init`);
    return { configFile, rootDir: dirname(configFile) };
  }
  const { file, stopDir } = walk(options.cwd);
  if (file === undefined) {
    const cwd = resolve(options.cwd);
    throw invalid(
      `no vetkit config found from ${cwd} up to ${stopDir}; looked for ${join(cwd, 'vetkit.config')}.${EXTENSIONS}; run: vet init`,
    );
  }
  return { configFile: file, rootDir: dirname(file) };
}

/** Root-relative paths shared by every command. */
export function projectPaths(rootDir: string, cacheDir: string): ProjectPaths {
  const evalsDir = join(rootDir, 'evals');
  const dataDir = existsSync(evalsDir) ? evalsDir : rootDir;
  return {
    rootDir,
    dataDir,
    criteria: join(dataDir, 'criteria.yaml'),
    cases: join(dataDir, 'cases'),
    labels: join(dataDir, 'labels'),
    gauntlet: join(dataDir, 'gauntlet'),
    lock: join(rootDir, LOCK_FILE),
    vitestOut: join(dataDir, 'vitest'),
    cacheDir: resolve(rootDir, cacheDir),
  };
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}

async function importConfigFile(file: string): Promise<unknown> {
  try {
    if (extname(file) === '.json') {
      const parsed = safeParseJson<unknown>(await readFile(file, 'utf8'), {});
      if (!parsed.ok) throw parsed.error;
      return parsed.value;
    }
    const mod: unknown = await import(pathToFileURL(file).href);
    return typeof mod === 'object' && mod !== null && 'default' in mod ? mod.default : mod;
  } catch (error) {
    const firstLine = (error instanceof Error ? error.message : String(error)).split('\n')[0];
    const hint = UNSUPPORTED_SYNTAX_CODES.has(String(errorCode(error)))
      ? '; Node strips types only: enums, namespaces, parameter properties and tsconfig paths are unsupported, use a union type, a plain object or vetkit.config.json'
      : '';
    throw new VetError(
      CEV_ERROR_CODES.CONFIG_INVALID,
      `cannot load ${file} on Node ${process.version}: ${firstLine}${hint}`,
      { cause: error },
    );
  }
}

function presetBaseURL(preset: string | undefined): string | undefined {
  return Object.entries(JEV_PRESETS).find(([name]) => name === preset)?.[1].baseURL;
}

// Paths and counts only: variable names and values are never printed.
function logEnvFiles(reports: readonly EnvFileReport[]): void {
  const log = getLogger();
  for (const report of reports) {
    if (report.error !== undefined) log.warn(report.error);
    else log.debug(`env files: ${report.path} (${report.applied.length} variables)`);
  }
}

/** Loads, validates and resolves vetkit.config.*; throws VetError CONFIG_INVALID on any problem. */
export async function loadVetConfig(options: LoadVetConfigOptions): Promise<LoadedVetConfig> {
  const { configFile, rootDir } = options.resolved ?? resolveConfigFile(options);
  const env = options.env ?? process.env;
  // Before the config is imported, so a top-level process.env read in it sees .env values.
  const envFiles = applyEnvFiles({ dir: dirname(configFile), env });
  logEnvFiles(envFiles);
  const { config, warnings } = resolveConfig(await importConfigFile(configFile));
  const missingCredentials: string[] = [];
  let judge: JudgeV1;
  let judgeBaseURL: string | undefined;
  if ('specVersion' in config.judge) {
    judge = config.judge;
  } else {
    const baseURLOverride = env[JUDGE_BASE_URL_ENV];
    const endpoint =
      baseURLOverride === undefined || baseURLOverride === ''
        ? config.judge
        : { ...config.judge, baseURL: baseURLOverride };
    judgeBaseURL = endpoint.baseURL ?? presetBaseURL(endpoint.preset);
    const keyEnv = endpoint.apiKeyEnv;
    const value = env[keyEnv];
    if (options.requireCredentials === false && (value === undefined || value === '')) {
      missingCredentials.push(keyEnv);
      judge = offlineJudge(judgeFromEndpoint(endpoint, UNSET_KEY_PLACEHOLDER), keyEnv);
    } else {
      if (value === undefined || value === '') throw invalid(missingKeyMessage(keyEnv));
      judge = judgeFromEndpoint(endpoint, readEnvName(keyEnv, env));
    }
  }
  // CEV_DIAG=1: count real judge requests (cache hits never reach doJudge) for diag.ts.
  if (diagEnabled(env)) judge = withJudgeDiag(judge);
  return {
    config,
    judge,
    warnings,
    missingCredentials,
    configFile,
    rootDir,
    paths: projectPaths(rootDir, config.cacheDir),
    envFiles,
    judgeBaseURL,
  };
}
