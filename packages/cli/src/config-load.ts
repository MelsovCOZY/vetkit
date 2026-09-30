// The CLI's one config loader used by `vet run` and reused by
// later commands. c12 finds and executes vetkit.config.ts; core resolveConfig validates it and
// applies defaults; the judge is then built here, in the CLI, never in core: an adapter object
// passes through, and a {kind: 'typesafe-compatible', …} descriptor becomes createJevJudge with
// its key read from the env var the config names.
import { dirname, resolve } from 'node:path';
import { readEnvName, resolveConfig, type ResolvedConfig } from '@vetkit/core';
import { createJevJudgeFromEndpoint, type JevProviderOptions } from '@vetkit/judge-jev';
import { CEV_ERROR_CODES, VetError, type JudgeEndpoint, type JudgeV1 } from '@vetkit/spec';
import { loadConfig } from 'c12';
import { diagEnabled, withJudgeDiag } from './diag.ts';

type Env = Readonly<Record<string, string | undefined>>;

export interface LoadVetConfigOptions {
  /** Directory searched for vetkit.config.* and against which configPath resolves. */
  readonly cwd: string;
  /** Explicit config file (`--config`); skips discovery. */
  readonly configPath?: string;
  /** Where descriptor apiKeyEnv names are read. Defaults to process.env. */
  readonly env?: Env;
  /**
   * False resolves the config for an offline command (estimate, doctor --config): an unset
   * apiKeyEnv does not throw but is listed in missingCredentials, and that judge's doJudge
   * rejects CONFIG_INVALID before any network call. Defaults to true.
   */
  readonly requireCredentials?: boolean;
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
}

const CONFIG_NAME = 'vetkit';
const JUDGE_KIND = 'typesafe-compatible';
const EXTENSIONS = '{ts,mts,cts,js,mjs,cjs,json}';
// A generic override of the judge transport's base URL for this
// process, so a test (or an operator) can force a judge failure without touching config.
// Named CEV_ (no vendor) since it applies to any typesafe-compatible endpoint, not one preset.
const JUDGE_BASE_URL_ENV = 'CEV_JUDGE_BASE_URL';

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
    throw invalid(`no vetkit config found; searched ${searched}; run: vet init`);
  }
  const { config, warnings } = resolveConfig(loaded.config);
  const env = options.env ?? process.env;
  const missingCredentials: string[] = [];
  let judge: JudgeV1;
  if ('specVersion' in config.judge) {
    judge = config.judge;
  } else {
    const baseURLOverride = env[JUDGE_BASE_URL_ENV];
    const endpoint =
      baseURLOverride === undefined || baseURLOverride === ''
        ? config.judge
        : { ...config.judge, baseURL: baseURLOverride };
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
    rootDir: dirname(configFile),
  };
}
