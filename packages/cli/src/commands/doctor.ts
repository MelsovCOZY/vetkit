import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { JEV_CREDENTIAL_PRIORITY, JEV_PRESETS, type JevPresetName } from '@vetkit/judge-jev';
import type { Command } from 'commander';

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

export interface DoctorResult {
  readonly checks: readonly DoctorCheck[];
  readonly exitCode: 0 | 1;
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

// Config resolution (defineConfig/describeConfig) lives in a separate, not-yet-landed
// leaf (classified-evals-mol-p15.1/.2), so these two rows can't yet name the actual
// generator/sink adapters a project configures. They stay a non-fatal warn until that
// leaf lands and this file is extended to call describeConfig().
function checkGeneratorCredential(configExists: boolean): DoctorCheck {
  return {
    name: 'generator credential',
    status: 'warn',
    detail: configExists
      ? 'config resolution is not available yet — cannot verify the generator credential'
      : 'no vetkit.config.ts — cannot determine which generator credential is required',
  };
}

function checkSinkCredentials(configExists: boolean): DoctorCheck {
  return {
    name: 'sink credentials',
    status: 'warn',
    detail: configExists
      ? 'config resolution is not available yet — cannot verify sink credentials'
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

function defaultConfigExists(): boolean {
  return ['vetkit.config.ts', 'vetkit.config.js', 'vetkit.config.mjs'].some((f) => existsSync(f));
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
}

export async function runDoctor(deps: DoctorDeps = {}): Promise<DoctorResult> {
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const revealSuffix = deps.revealSuffix ?? false;
  const strict = deps.strict ?? false;
  const configExists = (deps.configExists ?? defaultConfigExists)();
  const bunPresent = (deps.bunPresent ?? defaultBunPresent)();
  const lefthookInstalled = (deps.lefthookInstalled ?? defaultLefthookInstalled)();

  const selected = selectTransport(env);
  const checks: DoctorCheck[] = [
    checkNode(deps.nodeVersion ?? process.version),
    checkBun(bunPresent),
    checkConfig(configExists),
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

  const hasFail = checks.some((c) => c.status === 'fail');
  const hasWarn = checks.some((c) => c.status === 'warn');
  const exitCode: 0 | 1 = hasFail || (strict && hasWarn) ? 1 : 0;
  return { checks, exitCode };
}

export function renderTable(checks: readonly DoctorCheck[]): string {
  return checks.map((c) => `${c.status.padEnd(4)} ${c.name.padEnd(22)} ${c.detail}`).join('\n');
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
    .option('--json', 'print machine-readable JSON')
    .option('--reveal-suffix', 'show the last 4 characters of a set credential')
    .option('--strict', 'treat warnings as failures for the exit code')
    .action(async (options: { json?: boolean; revealSuffix?: boolean; strict?: boolean }) => {
      const result = await runDoctor({
        ...deps,
        revealSuffix: options.revealSuffix ?? deps.revealSuffix ?? false,
        strict: options.strict ?? deps.strict ?? false,
      });
      stdout.write(options.json ? `${renderJson(result)}\n` : `${renderTable(result.checks)}\n`);
      setExitCode(result.exitCode);
    });
}
