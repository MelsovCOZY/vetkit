import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describeConfig, type ResolvedConfig } from '@vetkit/core';
import { JEV_CREDENTIAL_PRIORITY, JEV_PRESETS, type JevPresetName } from '@vetkit/judge-jev';
import type { Command } from 'commander';
import { loadVetConfig, type LoadedVetConfig } from '../config-load.ts';
import { colors } from '../output.ts';

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

export interface DoctorResult {
  readonly checks: readonly DoctorCheck[];
  readonly exitCode: 0 | 1;
  readonly config?: DoctorConfigReport;
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

function checkJudgeCredential(env: Env, revealSuffix: boolean): DoctorCheck {
  const parts = ENV_VARS.map((v) => credentialStatusText(v.name, env, revealSuffix)).join(', ');
  const present = TRANSPORT_PRIORITY.filter((t) => transportCredentialPresent(t, env));
  const selected = TRANSPORT_PRIORITY.find((t) => transportCredentialPresent(t, env));
  if (selected === undefined) {
    const names = ENV_VARS.map((v) => v.name).join(', ');
    return {
      name: 'judge credential',
      status: 'fail',
      detail: `${parts} — none set; set one of ${names}`,
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
      readonly probe?: JudgeTransport;
      /** The config's accountId (the cloudflare preset), used in place of the env's. */
      readonly accountId?: string;
    }
  | { readonly kind: 'preset'; readonly transport: JudgeTransport }
  | { readonly kind: 'adapter'; readonly id: string; readonly transport: string };

function judgePlan(judge: ResolvedConfig['judge']): JudgePlan {
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
    transport: preset ?? `custom ${judge.baseURL ?? ''}`.trim(),
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
  const names =
    plan.kind === 'endpoint'
      ? [plan.keyEnv]
      : JEV_PRESETS[plan.transport].credentials.map((c) => c.name);
  const parts = names.map((n) => credentialStatusText(n, env, revealSuffix)).join(', ');
  const ok = names.every((n) => isSet(env[n]));
  return ok
    ? { name, status: 'pass', detail: `${parts} — transport: ${plan.transport} (from config)` }
    : {
        name,
        status: 'fail',
        detail: `${parts} — the config's ${plan.transport} judge needs ${names.join(', ')}`,
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
    return transportCredentialPresent(plan.transport, env)
      ? checkJudgeHealth(plan.transport, env, fetchImpl)
      : { name, status: 'fail', detail: 'judge credential unset — cannot probe endpoint health' };
  }
  if (plan.probe === undefined) {
    return { name, status: 'info', detail: `no health probe for ${plan.transport}` };
  }
  if (!isSet(env[plan.keyEnv])) {
    return {
      name,
      status: 'fail',
      detail: 'judge credential unset — cannot probe endpoint health',
    };
  }
  // The preset's probe authenticates with its first credential name; point that at the key
  // variable the config names. A preset whose endpoint takes an accountId pairs the bearer
  // with an account-id credential (its second) that the probe URL reads; the config's
  // accountId stands in for it.
  const [bearer, accountVar] = JEV_PRESETS[plan.probe].credentials.map((c) => c.name);
  const keyed = bearer === undefined ? env : { ...env, [bearer]: env[plan.keyEnv] };
  const probeEnv =
    accountVar === undefined || plan.accountId === undefined
      ? keyed
      : { ...keyed, [accountVar]: plan.accountId };
  return checkJudgeHealth(plan.probe, probeEnv, fetchImpl);
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

function checkConfiguredSinks(sinks: ResolvedConfig['sinks']): DoctorCheck {
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
  const ids = sinks.map((s) => (typeof s === 'string' ? s : s.id));
  return {
    name,
    status: 'pass',
    detail: `sink adapter(s) ${ids.join(', ')} supply their own credentials`,
  };
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

function checkBun(bunPresent: boolean): DoctorCheck {
  return {
    name: 'bun',
    status: bunPresent ? 'pass' : 'warn',
    detail: bunPresent
      ? 'bun present'
      : 'bun not found on PATH (dev-only; not required at runtime)',
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

function checkLefthook(installed: boolean): DoctorCheck {
  return {
    name: 'lefthook',
    status: installed ? 'pass' : 'warn',
    detail: installed ? 'lefthook installed' : 'lefthook not found — run `bun run hooks:install`',
  };
}

// Health endpoints come from the judge-jev presets; every probe authenticates with the
// preset's first credential as a bearer token.
function healthHeaders(transport: JudgeTransport, env: Env): Record<string, string> {
  const bearer = JEV_PRESETS[transport].credentials[0]?.name;
  return { Authorization: `Bearer ${(bearer === undefined ? undefined : env[bearer]) ?? ''}` };
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

async function checkJudgeHealth(
  transport: JudgeTransport,
  env: Env,
  fetchImpl: typeof fetch,
): Promise<DoctorCheck> {
  const preset = JEV_PRESETS[transport];
  const spec = preset.health;
  const url = spec.url(env);
  try {
    const res = await fetchImpl(url, {
      method: spec.method,
      headers: healthHeaders(transport, env),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      const body = spec.method === 'HEAD' ? undefined : await safeJson(res);
      return {
        name: 'judge endpoint health',
        status: 'warn',
        detail: `HTTP ${res.status}: ${hintForStatus(res.status, body)}`,
      };
    }
    const body = spec.method === 'HEAD' ? undefined : await safeJson(res);
    const parts: string[] = [];
    const name = fieldOf(body, 'name');
    const releaseDate = fieldOf(body, 'release_date');
    const finalProvider = fieldOf(body, 'finalProvider');
    const credentialType = fieldOf(body, 'credentialType');
    if (typeof name === 'string') parts.push(`model=${name}`);
    if (typeof releaseDate === 'string') parts.push(`release_date=${releaseDate}`);
    if (typeof finalProvider === 'string') parts.push(`finalProvider=${finalProvider}`);
    if (typeof credentialType === 'string') parts.push(`credentialType=${credentialType}`);
    const gateway = preset.providerOptions?.gateway;
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

function defaultConfigExists(cwd: string): boolean {
  return ['vetkit.config.ts', 'vetkit.config.js', 'vetkit.config.mjs'].some((f) =>
    existsSync(join(cwd, f)),
  );
}

type ConfigLoad =
  | { readonly ok: true; readonly loaded: LoadedVetConfig }
  | { readonly ok: false; readonly message: string };

async function loadForDoctor(cwd: string, config: true | string): Promise<ConfigLoad> {
  try {
    // Doctor must resolve the config even when a key it names is unset (reporting that is
    // its job); the judge loadVetConfig builds is discarded, never called.
    const loaded = await loadVetConfig({
      cwd,
      requireCredentials: false,
      ...(config === true ? {} : { configPath: config }),
    });
    return { ok: true, loaded };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'unknown error' };
  }
}

function commandOk(bin: string, args: readonly string[]): boolean {
  try {
    return spawnSync(bin, [...args], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

function defaultBunPresent(): boolean {
  return commandOk('bun', ['--version']);
}

function defaultLefthookInstalled(): boolean {
  return commandOk('lefthook', ['version']);
}

export interface DoctorDeps {
  readonly env?: Env;
  readonly fetchImpl?: typeof fetch;
  readonly nodeVersion?: string;
  readonly bunPresent?: () => boolean;
  readonly lefthookInstalled?: () => boolean;
  readonly configExists?: () => boolean;
  readonly revealSuffix?: boolean;
  readonly strict?: boolean;
  /** Directory the config is discovered in (and `config` paths resolve against). */
  readonly cwd?: string;
  /** `--config`: true discovers vetkit.config.*, a string names the file. */
  readonly config?: boolean | string;
}

interface DoctorRun {
  readonly result: DoctorResult;
  /** Text form of the --config section, when the config resolved. */
  readonly configText?: string;
}

export async function runDoctor(deps: DoctorDeps = {}): Promise<DoctorResult> {
  return (await inspect(deps)).result;
}

async function inspect(deps: DoctorDeps): Promise<DoctorRun> {
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const revealSuffix = deps.revealSuffix ?? false;
  const strict = deps.strict ?? false;
  const cwd = deps.cwd ?? process.cwd();
  const bunPresent = (deps.bunPresent ?? defaultBunPresent)();
  const lefthookInstalled = (deps.lefthookInstalled ?? defaultLefthookInstalled)();
  const nodeCheck = checkNode(deps.nodeVersion ?? process.version);

  const requested = deps.config ?? false;
  const load = requested === false ? undefined : await loadForDoctor(cwd, requested);
  let checks: DoctorCheck[];
  let report: DoctorConfigReport | undefined;
  let configText: string | undefined;
  if (load?.ok === true) {
    const { config, configFile, warnings } = load.loaded;
    const plan = judgePlan(config.judge);
    checks = [
      nodeCheck,
      checkBun(bunPresent),
      { name: 'config', status: 'pass', detail: `loaded ${configFile}` },
      checkPlannedJudgeCredential(plan, env, revealSuffix),
      checkConfiguredGenerator(config.generator, env, revealSuffix),
      checkConfiguredSinks(config.sinks),
      checkLefthook(lefthookInstalled),
      await checkPlannedJudgeHealth(plan, env, fetchImpl),
    ];
    report = { file: configFile, resolved: redactConfig(config, env), warnings };
    configText = renderConfigText(report, config);
  } else {
    const configExists =
      load === undefined ? (deps.configExists ?? (() => defaultConfigExists(cwd)))() : true;
    const selected = selectTransport(env);
    checks = [
      nodeCheck,
      checkBun(bunPresent),
      load === undefined
        ? checkConfig(configExists)
        : { name: 'config', status: 'fail', detail: load.message },
      checkJudgeCredential(env, revealSuffix),
      checkGeneratorCredential(configExists),
      checkSinkCredentials(configExists),
      checkLefthook(lefthookInstalled),
      selected
        ? await checkJudgeHealth(selected, env, fetchImpl)
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
  return report === undefined || configText === undefined
    ? { result: { checks, exitCode } }
    : { result: { checks, exitCode, config: report }, configText };
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
      '--config [path]',
      'resolve the vetkit config (default: vetkit.config.* here) and print it, *Env values as <set>/<unset>',
    )
    .action(async (_options: unknown, command: Command) => {
      // --json is a global program option; optsWithGlobals merges it with doctor's own.
      const options = command.optsWithGlobals<{
        json?: boolean;
        revealSuffix?: boolean;
        strict?: boolean;
        config?: boolean | string;
      }>();
      const { result, configText } = await inspect({
        ...deps,
        revealSuffix: options.revealSuffix ?? deps.revealSuffix ?? false,
        strict: options.strict ?? deps.strict ?? false,
        config: options.config ?? deps.config ?? false,
      });
      const table = renderTable(result.checks, statusPainter());
      stdout.write(
        options.json
          ? `${renderJson(result)}\n`
          : `${configText === undefined ? table : `${table}\n\n${configText}`}\n`,
      );
      setExitCode(result.exitCode);
    });
}
