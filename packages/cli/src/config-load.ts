// The CLI's one config loader (root DECISION: shared loader), used by `vet run` and reused by
// later commands. c12 finds and executes vetkit.config.ts; core resolveConfig validates it and
// applies defaults; the judge is then built here, in the CLI, never in core: an adapter object
// passes through, and a {kind: 'typesafe-compatible', …} descriptor becomes createJevJudge with
// its key read from the env var the config names (DECISION: Architecture as presented).
import { dirname, resolve } from 'node:path';
import { readEnvName, resolveConfig, type ResolvedConfig } from '@vetkit/core';
import {
  createJevJudge,
  JEV_PRESETS,
  type JevPresetName,
  type JevProviderOptions,
} from '@vetkit/judge-jev';
import { CEV_ERROR_CODES, VetError, type JudgeEndpoint, type JudgeV1 } from '@vetkit/spec';
import { loadConfig } from 'c12';

type Env = Readonly<Record<string, string | undefined>>;

export interface LoadVetConfigOptions {
  /** Directory searched for vetkit.config.* and against which configPath resolves. */
  readonly cwd: string;
  /** Explicit config file (`--config`); skips discovery. */
  readonly configPath?: string;
  /** Where descriptor apiKeyEnv names are read. Defaults to process.env. */
  readonly env?: Env;
}

export interface LoadedVetConfig {
  readonly config: ResolvedConfig;
  /** The judge, ready to call: the config's adapter object or one built from its descriptor. */
  readonly judge: JudgeV1;
  readonly warnings: readonly string[];
  /** Absolute path of the loaded config file. */
  readonly configFile: string;
  /** The config file's directory: project-relative paths resolve against it. */
  readonly rootDir: string;
}

const CONFIG_NAME = 'vetkit';
const JUDGE_KIND = 'typesafe-compatible';
const EXTENSIONS = '{ts,mts,cts,js,mjs,cjs,json}';

function isPreset(name: string): name is JevPresetName {
  return Object.hasOwn(JEV_PRESETS, name);
}

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

function judgeFromEndpoint(endpoint: JudgeEndpoint, env: Env): JudgeV1 {
  if (endpoint.kind !== JUDGE_KIND) {
    throw invalid(`judge kind "${endpoint.kind}" is not supported; use "${JUDGE_KIND}"`);
  }
  const apiKey = readEnvName(endpoint.apiKeyEnv, env);
  const providerOptions = endpoint.providerOptions;
  if (providerOptions !== undefined && !isProviderOptions(providerOptions)) {
    throw invalid('judge providerOptions must be { gateway: { zeroDataRetention, only } }');
  }
  const extra = { apiKey, ...(providerOptions === undefined ? {} : { providerOptions }) };
  const { preset, baseURL, model } = endpoint;
  if (preset === undefined) {
    if (baseURL === undefined || model === undefined) {
      throw invalid('judge endpoint needs a preset, or a baseURL and a model');
    }
    return createJevJudge({ baseURL, model, ...extra });
  }
  if (!isPreset(preset)) {
    throw invalid(
      `unknown judge preset "${preset}"; known: ${Object.keys(JEV_PRESETS).join(', ')}`,
    );
  }
  if (preset === 'cloudflare') {
    if (endpoint.accountId === undefined)
      throw invalid('judge preset "cloudflare" needs accountId');
    return createJevJudge({
      preset,
      accountId: endpoint.accountId,
      apiKeyEnv: endpoint.apiKeyEnv,
      ...extra,
    });
  }
  return createJevJudge({
    preset,
    ...(baseURL === undefined ? {} : { baseURL }),
    ...(model === undefined ? {} : { model }),
    ...extra,
  });
}

/** Loads, validates and resolves vetkit.config.*; throws VetError CONFIG_INVALID on any problem. */
export async function loadVetConfig(options: LoadVetConfigOptions): Promise<LoadedVetConfig> {
  const explicit =
    options.configPath === undefined ? undefined : resolve(options.cwd, options.configPath);
  const searched =
    explicit ??
    `${resolve(options.cwd, `${CONFIG_NAME}.config`)}.${EXTENSIONS}, ${resolve(options.cwd, '.config', CONFIG_NAME)}.${EXTENSIONS}`;
  // Only the config file itself: no rc files, package.json, .env, env overrides or extends.
  const loaded = await loadConfig<Record<string, unknown>>({
    name: CONFIG_NAME,
    cwd: explicit === undefined ? options.cwd : dirname(explicit),
    ...(explicit === undefined ? {} : { configFile: explicit }),
    rcFile: false,
    globalRc: false,
    dotenv: false,
    packageJson: false,
    envName: false,
    extend: false,
    giget: false,
  });
  // c12's public field for the file it actually loaded (configFile is set even when missing).
  // oxlint-disable-next-line eslint/no-underscore-dangle
  const configFile = loaded._configFile;
  if (configFile === undefined) {
    throw invalid(`no vetkit config found; searched ${searched}`);
  }
  const { config, warnings } = resolveConfig(loaded.config);
  const judge =
    'specVersion' in config.judge
      ? config.judge
      : judgeFromEndpoint(config.judge, options.env ?? process.env);
  return { config, judge, warnings, configFile, rootDir: dirname(configFile) };
}
