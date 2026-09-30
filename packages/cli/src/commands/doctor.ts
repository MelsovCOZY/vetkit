import { describeConfig, type ResolvedConfig } from '@vetkit/core';
import { JEV_CREDENTIAL_PRIORITY, JEV_PRESETS, type JevPresetName } from '@vetkit/judge-jev';
import type { Command } from 'commander';
import { findConfigFile, loadVetConfig, type LoadedVetConfig } from '../config-load.ts';
import { colors } from '../output.ts';
import { sinkRefName } from '../sinks.ts';

// Structural stand-in for NodeJS.WritableStream (see errors.ts / logger.ts): keeps this
// module's public surface independent of @types/node ambient globals.
interface WritableLike {
  write(chunk: string): unknown;
}

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'info';

export interface DoctorCheck {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: string;
}

/** The `--config` section: the resolved config with every *Env value as <set>/<unset>. */
export interface DoctorConfigReport {
  readonly file: string;
  readonly resolved: unknown;
  readonly warnings: readonly string[];
}

/** Which layer supplied a resolved value; `.env` sits between env and config. */
export type ValueSource = 'flag' | 'env' | '.env' | 'config' | 'default';

/** One resolved judge value and its layer. A credential is only ever `<set>`/`<unset>`. */
export interface ResolvedValue {
  readonly name: string;
  readonly value: string;
  readonly source: ValueSource;
}

export interface DoctorResult {
  readonly checks: readonly DoctorCheck[];
  readonly exitCode: 0 | 1;
  readonly config?: DoctorConfigReport;
  /** Present only when a config resolved. */
  readonly values?: readonly ResolvedValue[];
}

export interface EnvVarDoc {
  readonly name: string;
  readonly purpose: string;
  readonly transport: string;
}

export type JudgeTransport = JevPresetName;

// The judge credentials the design accepts and the transport each unblocks, derived
// from the judge-jev presets. Priority order is also the tie-break order when more than
// one is set (JEV_CREDENTIAL_PRIORITY).
const TRANSPORT_PRIORITY: readonly JudgeTransport[] = JEV_CREDENTIAL_PRIORITY;

export const ENV_VARS: readonly EnvVarDoc[] = TRANSPORT_PRIORITY.flatMap((transport) =>
  JEV_PRESETS[transport].credentials.map((c) => ({
    name: c.name,
    purpose: c.purpose,
    transport,
  })),
);

type Env = Record<string, string | undefined>;

function isSet(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

function transportCredentialPresent(transport: JudgeTransport, env: Env): boolean {
  return JEV_PRESETS[transport].credentials.every((c) => isSet(env[c.name]));
}

function selectTransport(env: Env): JudgeTransport | undefined {
  return TRANSPORT_PRIORITY.find((t) => transportCredentialPresent(t, env));
}

function credentialStatusText(name: string, env: Env, revealSuffix: boolean): string {
  const value = env[name];
  if (!isSet(value)) return `${name}=<unset>`;
  return revealSuffix ? `${name}=<set:...${value.slice(-4)}>` : `${name}=<set>`;
}

function transportNames(transport: JudgeTransport): string[] {
  return JEV_PRESETS[transport].credentials.map((c) => c.name);
}

// A multi-variable credential (one transport needing several names) reads as one unit:
// `A+B=<unset>` when every name shares a state, else each name with its own state.
function groupStatusText(names: readonly string[], env: Env, revealSuffix: boolean): string {
  const set = names.map((n) => isSet(env[n]));
  if (names.length > 1 && !revealSuffix && set.every((s) => s === set[0])) {
    return `${names.join('+')}=${set[0] === true ? '<set>' : '<unset>'}`;
  }
  return names.map((n) => credentialStatusText(n, env, revealSuffix)).join('+');
}

function missingNote(names: readonly string[], env: Env, transport: string): string {
  return names
    .filter((n) => !isSet(env[n]))
    .map((n) => `${n} is missing for ${transport}`)
    .join('; ');
}

function checkJudgeCredential(env: Env, revealSuffix: boolean): DoctorCheck {
  const parts = TRANSPORT_PRIORITY.map((t) =>
    groupStatusText(transportNames(t), env, revealSuffix),
  ).join(', ');
  const present = TRANSPORT_PRIORITY.filter((t) => transportCredentialPresent(t, env));
  const selected = TRANSPORT_PRIORITY.find((t) => transportCredentialPresent(t, env));
  if (selected === undefined) {
    const names = TRANSPORT_PRIORITY.map((t) => transportNames(t).join('+')).join(', ');
    const partial = TRANSPORT_PRIORITY.filter((t) =>
      transportNames(t).some((n) => isSet(env[n])),
    ).map((t) => missingNote(transportNames(t), env, t));
    const missing = partial.length > 0 ? `; ${partial.join('; ')}` : '';
    return {
      name: 'judge credential',
      status: 'fail',
      detail: `${parts} — none set; set one of ${names}${missing}`,
    };
  }
  if (present.length > 1) {
    return {
      name: 'judge credential',
      status: 'info',
      detail: `${parts} — config selects ${selected}`,
    };
  }
  return { name: 'judge credential', status: 'pass', detail: `${parts} — transport: ${selected}` };
}

function isPresetName(name: unknown): name is JudgeTransport {
  return typeof name === 'string' && Object.hasOwn(JEV_PRESETS, name);
}

// What the resolved config says about the judge's credential and endpoint probe:
// - an endpoint names its own key variable (and, for a preset, the preset to probe);
// - an adapter object whose transport is a known preset needs that preset's credentials;
// - any other adapter object holds its own credential and has no probe here.
type JudgePlan =
  | {
      readonly kind: 'endpoint';
      readonly keyEnv: string;
      readonly transport: string;
      /** The base URL the judge talks to (config, CEV_JUDGE_BASE_URL or the preset's). */
      readonly baseURL?: string;
      readonly probe?: JudgeTransport;
      /** The config's accountId (the cloudflare preset), used in place of the env's. */
      readonly accountId?: string;
    }
  | { readonly kind: 'preset'; readonly transport: JudgeTransport }
  | { readonly kind: 'adapter'; readonly id: string; readonly transport: string };

function judgePlan(judge: ResolvedConfig['judge'], baseURL: string | undefined): JudgePlan {
  if ('specVersion' in judge) {
    const transport = judge.capabilities.transport;
    return isPresetName(transport)
      ? { kind: 'preset', transport }
      : { kind: 'adapter', id: judge.id, transport };
  }
  const preset = judge.preset;
  return {
    kind: 'endpoint',
    keyEnv: judge.apiKeyEnv,
    transport: preset ?? 'custom',
    ...(baseURL === undefined ? {} : { baseURL }),
    ...(isPresetName(preset) ? { probe: preset } : {}),
    ...(judge.accountId === undefined ? {} : { accountId: judge.accountId }),
  };
}

function checkPlannedJudgeCredential(
  plan: JudgePlan,
  env: Env,
  revealSuffix: boolean,
): DoctorCheck {
  const name = 'judge credential';
  if (plan.kind === 'adapter') {
    return {
      name,
      status: 'pass',
      detail: `adapter ${plan.id} (transport ${plan.transport}) supplies its own credential`,
    };
  }
  const names = plan.kind === 'endpoint' ? [plan.keyEnv] : transportNames(plan.transport);
  const parts = groupStatusText(names, env, revealSuffix);
  const ok = names.every((n) => isSet(env[n]));
  return ok
    ? { name, status: 'pass', detail: `${parts} — transport: ${plan.transport} (from config)` }
    : {
        name,
        status: 'fail',
        detail: `${parts} — the config's ${plan.transport} judge needs ${names.join('+')}; ${missingNote(names, env, plan.transport)}`,
      };
}

async function checkPlannedJudgeHealth(
  plan: JudgePlan,
  env: Env,
  fetchImpl: typeof fetch,
): Promise<DoctorCheck> {
  const name = 'judge endpoint health';
  if (plan.kind === 'adapter') {
    return { name, status: 'info', detail: `adapter ${plan.id} judge — no endpoint probe` };
  }
  if (plan.kind === 'preset') {
    const [bearer] = transportNames(plan.transport);
    return transportCredentialPresent(plan.transport, env)
      ? checkJudgeHealth(
          presetProbe(plan.transport, JEV_PRESETS[plan.transport].baseURL, env, bearer),
          fetchImpl,
        )
      : { name, status: 'fail', detail: 'judge credential unset — cannot probe endpoint health' };
  }
  if (!isSet(env[plan.keyEnv])) {
    return {
      name,
      status: 'fail',
      detail: 'judge credential unset — cannot probe endpoint health',
    };
  }
  const baseURL = plan.baseURL ?? '';
  if (plan.probe === undefined) {
    // No preset knows this endpoint: the typesafe-compatible models listing is the probe.
    return checkJudgeHealth(
      { url: joinURL(baseURL, '/v1/models'), method: 'GET', token: env[plan.keyEnv] },
      fetchImpl,
    );
  }
  // A preset whose endpoint takes an accountId pairs the bearer with an account-id credential
  // (its second) that the probe path reads; the config's accountId stands in for it.
  const accountVar = transportNames(plan.probe)[1];
  const probeEnv =
    accountVar === undefined || plan.accountId === undefined
      ? env
      : { ...env, [accountVar]: plan.accountId };
  return checkJudgeHealth(
    presetProbe(plan.probe, baseURL, probeEnv, undefined, env[plan.keyEnv]),
    fetchImpl,
  );
}

function checkConfiguredGenerator(
  generator: ResolvedConfig['generator'],
  env: Env,
  revealSuffix: boolean,
): DoctorCheck {
  const name = 'generator credential';
  if (generator === undefined) {
    return { name, status: 'info', detail: 'no generator configured' };
  }
  if ('specVersion' in generator) {
    return { name, status: 'pass', detail: `adapter ${generator.id} supplies its own credential` };
  }
  const text = credentialStatusText(generator.apiKeyEnv, env, revealSuffix);
  return isSet(env[generator.apiKeyEnv])
    ? { name, status: 'pass', detail: `${text} — ${generator.kind} model ${generator.model}` }
    : {
        name,
        status: 'fail',
        detail: `${text} — the config's ${generator.kind} generator needs ${generator.apiKeyEnv}`,
      };
}

// A descriptor names its credential variables in `*Env` properties (optional ones may be
// absent); doctor reports each by name and set/unset, never by value.
function descriptorEnvNames(descriptor: object): string[] {
  return Object.entries(descriptor)
    .filter(([key, v]) => key.endsWith('Env') && typeof v === 'string')
    .map(([, v]) => String(v));
}

function checkConfiguredSinks(sinks: ResolvedConfig['sinks'], env: Env): DoctorCheck {
  const name = 'sink credentials';
  if (sinks.length === 0) return { name, status: 'info', detail: 'no sinks configured' };
  const bare = sinks.filter((s): s is string => typeof s === 'string');
  if (bare.length > 0) {
    return {
      name,
      status: 'warn',
      detail: `sink name(s) ${bare.join(', ')} resolve to no adapter object — cannot verify their credentials`,
    };
  }
  const descriptors = sinks.filter((s) => typeof s !== 'string' && 'kind' in s);
  const adapters = sinks.filter((s) => typeof s !== 'string' && !('kind' in s));
  const parts: string[] = [];
  if (adapters.length > 0) {
    parts.push(`adapter(s) ${adapters.map(sinkRefName).join(', ')} supply their own credentials`);
  }
  let unset = false;
  for (const d of descriptors) {
    const vars = descriptorEnvNames(d).map((n) => credentialStatusText(n, env, false));
    unset ||= vars.some((v) => v.endsWith('=<unset>'));
    parts.push(`descriptor ${sinkRefName(d)} (${vars.join(', ')})`);
  }
  const detail = `sink ${parts.join('; ')}`;
  return unset
    ? { name, status: 'warn', detail: `${detail} — set the unset variable(s) before running` }
    : { name, status: 'pass', detail };
}

// Every `*Env` string becomes <set>/<unset> (the variable name is dropped too); an adapter
// object is reduced to its {specVersion, id, capabilities} identity so no property it
// holds (a client, a key) can print.
function redactConfig(value: unknown, env: Env): unknown {
  if (Array.isArray(value)) return value.map((item: unknown) => redactConfig(item, env));
  if (!isRecord(value)) return value;
  const entries = Object.entries(value).filter(
    ([key]) => !('specVersion' in value) || ['specVersion', 'id', 'capabilities'].includes(key),
  );
  return Object.fromEntries(
    entries.map(([key, v]) => [
      key,
      key.endsWith('Env') && typeof v === 'string'
        ? isSet(env[v])
          ? '<set>'
          : '<unset>'
        : redactConfig(v, env),
    ]),
  );
}

function checkNode(nodeVersion: string): DoctorCheck {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(nodeVersion);
  if (!match)
    return {
      name: 'node',
      status: 'fail',
      detail: `could not parse node version "${nodeVersion}"`,
    };
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const meetsFloor = major > 22 || (major === 22 && minor >= 12);
  return {
    name: 'node',
    status: meetsFloor ? 'pass' : 'fail',
    detail: meetsFloor ? `${nodeVersion} >= 22.12` : `${nodeVersion} is below the 22.12 floor`,
  };
}

function checkConfig(configExists: boolean): DoctorCheck {
  return configExists
    ? { name: 'config', status: 'pass', detail: 'vetkit.config.ts found' }
    : { name: 'config', status: 'fail', detail: 'no vetkit.config.ts' };
}

// Without --config the config is not resolved, so these two rows can only say how to get
// a real per-adapter check (checkConfiguredGenerator / checkConfiguredSinks).
function checkGeneratorCredential(configExists: boolean): DoctorCheck {
  return {
    name: 'generator credential',
    status: 'warn',
    detail: configExists
      ? 'config not resolved — pass --config to verify the generator credential'
      : 'no vetkit.config.ts — cannot determine which generator credential is required',
  };
}

function checkSinkCredentials(configExists: boolean): DoctorCheck {
  return {
    name: 'sink credentials',
    status: 'warn',
    detail: configExists
      ? 'config not resolved — pass --config to verify sink credentials'
      : 'no vetkit.config.ts — cannot determine which sink credentials are required',
  };
}

function joinURL(baseURL: string, path: string): string {
  return `${baseURL.replace(/\/+$/, '')}${path}`;
}

interface HealthProbe {
  readonly url: string;
  readonly method: 'GET' | 'HEAD';
  /** Bearer token; never printed. */
  readonly token: string | undefined;
  readonly preset?: JudgeTransport;
}

// Health endpoints come from the judge-jev presets (a path relative to the base URL in
// use); every probe authenticates with a bearer token, the preset's first credential unless
// the config names its own key variable (`token`).
function presetProbe(
  transport: JudgeTransport,
  baseURL: string,
  env: Env,
  bearerName: string | undefined = transportNames(transport)[0],
  token: string | undefined = bearerName === undefined ? undefined : env[bearerName],
): HealthProbe {
  const spec = JEV_PRESETS[transport].health;
  return { url: joinURL(baseURL, spec.path(env)), method: spec.method, token, preset: transport };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// Reads `value[key]` only after narrowing `value` to a plain object, so callers never
// need an `as Record<...>` assertion to walk an untrusted (`unknown`) response body.
function fieldOf(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

// One-sentence hints for the HTTP error shapes the design calls out: gateway 401/402,
// two distinct 403 causes (customer verification, free-tier model), and TypeSafe's own
// 403 which nests the same error_type one level deeper under `detail`.
function hintForStatus(httpStatus: number, body: unknown): string {
  const errorType =
    fieldOf(fieldOf(body, 'error'), 'type') ?? fieldOf(fieldOf(body, 'detail'), 'error_type');
  if (httpStatus === 401) {
    return 'unauthorized — check the judge credential is correct and not expired.';
  }
  if (httpStatus === 402) {
    return 'no credit or budget exhausted — add funds or raise the budget for this transport.';
  }
  if (httpStatus === 403 && errorType === 'customer_verification_required') {
    return 'the account needs identity verification before this model can be used.';
  }
  if (httpStatus === 403 && errorType === 'free_tier_model_not_available') {
    return 'this model is not available on the free tier — upgrade or choose another model.';
  }
  if (httpStatus === 403) {
    return 'forbidden — check the judge credential has access to this model.';
  }
  return `unexpected ${httpStatus} from the judge endpoint.`;
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

// A rejected credential is a failure (the judge cannot run); every other non-2xx stays a warn.
function isAuthRejection(httpStatus: number, body: unknown): boolean {
  return (
    httpStatus === 401 ||
    (httpStatus === 403 &&
      fieldOf(fieldOf(body, 'detail'), 'error_type') === 'authentication_error')
  );
}

async function checkJudgeHealth(probe: HealthProbe, fetchImpl: typeof fetch): Promise<DoctorCheck> {
  const preset = probe.preset === undefined ? undefined : JEV_PRESETS[probe.preset];
  try {
    const res = await fetchImpl(probe.url, {
      method: probe.method,
      headers: { Authorization: `Bearer ${probe.token ?? ''}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      const body = probe.method === 'HEAD' ? undefined : await safeJson(res);
      return {
        name: 'judge endpoint health',
        status: isAuthRejection(res.status, body) ? 'fail' : 'warn',
        detail: `HTTP ${res.status}: ${hintForStatus(res.status, body)}`,
      };
    }
    const body = probe.method === 'HEAD' ? undefined : await safeJson(res);
    const parts: string[] = [];
    const name = fieldOf(body, 'name');
    const releaseDate = fieldOf(body, 'release_date');
    const finalProvider = fieldOf(body, 'finalProvider');
    const credentialType = fieldOf(body, 'credentialType');
    if (typeof name === 'string') parts.push(`model=${name}`);
    if (typeof releaseDate === 'string') parts.push(`release_date=${releaseDate}`);
    if (typeof finalProvider === 'string') parts.push(`finalProvider=${finalProvider}`);
    if (typeof credentialType === 'string') parts.push(`credentialType=${credentialType}`);
    const gateway = preset?.providerOptions?.gateway;
    const zdrNote =
      gateway?.zeroDataRetention === true
        ? ` (zero-data-retention is best-effort only: routes solely to ${gateway.only.join(', ')}; the live provider catalog reports no ZDR guarantee)`
        : '';
    return {
      name: 'judge endpoint health',
      status: 'pass',
      detail: `${parts.length > 0 ? parts.join(' ') : 'ok'}${zdrNote}`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    return { name: 'judge endpoint health', status: 'warn', detail: `unreachable: ${message}` };
  }
}

type ConfigLoad =
  | { readonly ok: true; readonly loaded: LoadedVetConfig }
  | { readonly ok: false; readonly message: string };

async function loadForDoctor(cwd: string, config: true | string, env: Env): Promise<ConfigLoad> {
  try {
    // Doctor must resolve the config even when a key it names is unset (reporting that is
    // its job); the judge loadVetConfig builds is discarded, never called.
    const loaded = await loadVetConfig({
      cwd,
      requireCredentials: false,
      env,
      ...(config === true ? {} : { configPath: config }),
    });
    return { ok: true, loaded };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'unknown error' };
  }
}

export interface DoctorDeps {
  readonly env?: Env;
  readonly fetchImpl?: typeof fetch;
  readonly nodeVersion?: string;
  readonly configExists?: () => boolean;
  readonly revealSuffix?: boolean;
  readonly strict?: boolean;
  /** Directory the config is discovered in (and `config` paths resolve against). */
  readonly cwd?: string;
  /** `--config`: true discovers vetkit.config.*, a string names the file; unset resolves it when one is found. */
  readonly config?: boolean | string;
}

interface DoctorRun {
  readonly result: DoctorResult;
  /** Text form of the values block, when the config resolved. */
  readonly valuesText?: string;
  /** Text form of the --config section, when --config was given and the config resolved. */
  readonly configText?: string;
}

export async function runDoctor(deps: DoctorDeps = {}): Promise<DoctorResult> {
  return (await inspect(deps)).result;
}

// The env var the loader reads to override the judge base URL (config-load.ts); doctor only
// names it to report the `env` layer.
const JUDGE_BASE_URL_ENV = 'CEV_JUDGE_BASE_URL';

// One row per resolved judge value with the layer that supplied it, from the loader's own
// report: a key is `.env` by NAME in an env file's `applied` list, never by comparing values.
function resolvedValues(loaded: LoadedVetConfig, env: Env, flagged: boolean): ResolvedValue[] {
  const { config, configFile, envFiles, judgeBaseURL } = loaded;
  const file: ResolvedValue = {
    name: 'config file',
    value: configFile,
    source: flagged ? 'flag' : 'config',
  };
  const judge = config.judge;
  if ('specVersion' in judge) {
    return [file, { name: 'transport', value: judge.capabilities.transport, source: 'config' }];
  }
  const preset = isPresetName(judge.preset) ? JEV_PRESETS[judge.preset] : undefined;
  const model = judge.model ?? preset?.defaultModel;
  const keyValueSource: ValueSource = envFiles.some((f) => f.applied.includes(judge.apiKeyEnv))
    ? '.env'
    : isSet(env[judge.apiKeyEnv])
      ? 'env'
      : 'default';
  const baseURLSource: ValueSource = isSet(env[JUDGE_BASE_URL_ENV])
    ? 'env'
    : judge.baseURL === undefined
      ? 'default'
      : 'config';
  const rows: ResolvedValue[] = [
    file,
    { name: 'transport', value: judge.preset ?? 'custom', source: 'config' },
  ];
  if (judgeBaseURL !== undefined) {
    rows.push({ name: 'baseURL', value: judgeBaseURL, source: baseURLSource });
  }
  if (model !== undefined) {
    rows.push({
      name: 'model',
      value: model,
      source: judge.model === undefined ? 'default' : 'config',
    });
  }
  rows.push(
    { name: 'key var', value: judge.apiKeyEnv, source: 'config' },
    {
      name: 'key value',
      value: isSet(env[judge.apiKeyEnv]) ? '<set>' : '<unset>',
      source: keyValueSource,
    },
  );
  return rows;
}

async function inspect(deps: DoctorDeps): Promise<DoctorRun> {
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const revealSuffix = deps.revealSuffix ?? false;
  const strict = deps.strict ?? false;
  const cwd = deps.cwd ?? process.cwd();
  const nodeCheck = checkNode(deps.nodeVersion ?? process.version);

  // The config resolves unless none was asked for and none is found.
  const requested = deps.config === undefined || deps.config === false ? undefined : deps.config;
  const found =
    requested !== undefined || (deps.configExists ?? (() => findConfigFile(cwd) !== undefined))();
  const load = found ? await loadForDoctor(cwd, requested ?? true, env) : undefined;
  let checks: DoctorCheck[];
  let report: DoctorConfigReport | undefined;
  let values: ResolvedValue[] | undefined;
  let configText: string | undefined;
  if (load?.ok === true) {
    const { config, configFile, warnings, judgeBaseURL } = load.loaded;
    const plan = judgePlan(config.judge, judgeBaseURL);
    checks = [
      nodeCheck,
      { name: 'config', status: 'pass', detail: `loaded ${configFile}` },
      checkPlannedJudgeCredential(plan, env, revealSuffix),
      checkConfiguredGenerator(config.generator, env, revealSuffix),
      checkConfiguredSinks(config.sinks, env),
      await checkPlannedJudgeHealth(plan, env, fetchImpl),
    ];
    values = resolvedValues(load.loaded, env, typeof requested === 'string');
    if (requested !== undefined) {
      report = { file: configFile, resolved: redactConfig(config, env), warnings };
      configText = renderConfigText(report, config);
    }
  } else {
    const selected = selectTransport(env);
    checks = [
      nodeCheck,
      load === undefined
        ? checkConfig(false)
        : { name: 'config', status: 'fail', detail: load.message },
      checkJudgeCredential(env, revealSuffix),
      checkGeneratorCredential(load !== undefined),
      checkSinkCredentials(load !== undefined),
      selected
        ? await checkJudgeHealth(
            presetProbe(selected, JEV_PRESETS[selected].baseURL, env),
            fetchImpl,
          )
        : {
            name: 'judge endpoint health',
            status: 'fail',
            detail: 'no judge credential set — cannot probe endpoint health',
          },
    ];
  }

  const hasFail = checks.some((c) => c.status === 'fail');
  const hasWarn = checks.some((c) => c.status === 'warn');
  const exitCode: 0 | 1 = hasFail || (strict && hasWarn) ? 1 : 0;
  return {
    result: {
      checks,
      exitCode,
      ...(report === undefined ? {} : { config: report }),
      ...(values === undefined ? {} : { values }),
    },
    ...(values === undefined ? {} : { valuesText: renderValues(values) }),
    ...(configText === undefined ? {} : { configText }),
  };
}

// `  key value    <set> (.env)`: name column padded like the check table's.
function renderValues(values: readonly ResolvedValue[]): string {
  return ['values', ...values.map((v) => `  ${v.name.padEnd(12)} ${v.value} (${v.source})`)].join(
    '\n',
  );
}

// Text form of the `--config` section: the file, describeConfig lines (env var names, never
// values) and resolveConfig warnings.
function renderConfigText(report: DoctorConfigReport, config: ResolvedConfig): string {
  const lines = [
    `config ${report.file}`,
    ...describeConfig(config).map((line) => `  ${line}`),
    ...report.warnings.map((w) => `  warning: ${w}`),
  ];
  return lines.join('\n');
}

// `paint` colours only the status word; the padding stays outside it so the plain text
// is byte-identical whether colour is on or off.
export function renderTable(
  checks: readonly DoctorCheck[],
  paint: (status: CheckStatus, text: string) => string = (_status, text) => text,
): string {
  return checks
    .map(
      (c) =>
        `${paint(c.status, c.status)}${' '.repeat(Math.max(0, 4 - c.status.length))} ${c.name.padEnd(22)} ${c.detail}`,
    )
    .join('\n');
}

function statusPainter(): (status: CheckStatus, text: string) => string {
  const c = colors();
  const byStatus = { pass: c.green, warn: c.yellow, fail: c.red, info: c.cyan } as const;
  return (status, text) => byStatus[status](text);
}

export function renderJson(result: DoctorResult): string {
  return JSON.stringify(result, null, 2);
}

interface RegisterDoctorDeps extends DoctorDeps {
  readonly stdout?: WritableLike;
  readonly setExitCode?: (code: number) => void;
}

export function registerDoctor(program: Command, deps: RegisterDoctorDeps = {}): Command {
  const stdout = deps.stdout ?? process.stdout;
  const setExitCode = deps.setExitCode ?? ((code: number) => (process.exitCode = code));
  return program
    .command('doctor')
    .description('check environment, judge credentials and judge endpoint health')
    .option('--reveal-suffix', 'show the last 4 characters of a set credential')
    .option('--strict', 'treat warnings as failures for the exit code')
    .option(
      '--config <path>',
      'use this vetkit config file (default: the discovered one) and print it, *Env values as <set>/<unset>',
    )
    .action(async (_options: unknown, command: Command) => {
      // --json is a global program option; optsWithGlobals merges it with doctor's own.
      const options = command.optsWithGlobals<{
        json?: boolean;
        revealSuffix?: boolean;
        strict?: boolean;
        config?: boolean | string;
      }>();
      const { result, valuesText, configText } = await inspect({
        ...deps,
        revealSuffix: options.revealSuffix ?? deps.revealSuffix ?? false,
        strict: options.strict ?? deps.strict ?? false,
        ...(options.config === undefined && deps.config === undefined
          ? {}
          : { config: options.config ?? deps.config }),
      });
      const table = renderTable(result.checks, statusPainter());
      stdout.write(
        options.json
          ? `${renderJson(result)}\n`
          : `${[table, valuesText, configText].filter((block) => block !== undefined).join('\n\n')}\n`,
      );
      setExitCode(result.exitCode);
    });
}
