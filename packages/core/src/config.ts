// vetkit.config.ts: defineConfig + validation + defaults. judge/generator accept
// `string | endpoint | adapter object`; strings resolve only through the user's `registry`,
// never an implicit env-chosen default. The declarative shape
// lives in packages/spec/schemas/config.schema.json; adapter objects are validated there as a
// {specVersion, id, capabilities} projection, and their methods are checked structurally here.
// Loading the config file and file:// references belong to the CLI, not here.
import {
  CEV_ERROR_CODES,
  configSchema,
  validateJson,
  VetError,
  type ConfigDoc,
  type GateConfig,
  type GeneratorEndpoint,
  type JudgeEndpoint,
  type JudgeV1,
  type PluginRef,
  type ThresholdsPolicy,
  type WatchConfig,
} from '@vetkit/spec';

export type { GeneratorEndpoint, JudgeEndpoint } from '@vetkit/spec';

// A configured sink: an opaque name, an adapter object, or a
// `{kind,*Env}` descriptor the CLI resolves by reading the named env vars.
// Derived structurally from ConfigDoc so the descriptor shapes never need a
// second hand-written declaration here.
export type SinkRef = NonNullable<ConfigDoc['sinks']>[number];
export type SinkDescriptor = Exclude<SinkRef, PluginRef>;

// The structural minimum config checks of a generator adapter object; the full port is GeneratorV1.
export interface GeneratorAdapter {
  readonly specVersion: 'v1';
  readonly id: string;
  readonly capabilities: Record<string, unknown>;
  doGenerate(req: never): Promise<unknown>;
}

export type RegistryEntry = JudgeEndpoint | JudgeV1 | GeneratorEndpoint | GeneratorAdapter;

type RoleValue<R extends Role> = R extends 'judge'
  ? JudgeEndpoint | JudgeV1
  : GeneratorEndpoint | GeneratorAdapter;

export interface VetkitConfig {
  readonly generator?: string | GeneratorEndpoint | GeneratorAdapter;
  readonly judge: string | JudgeEndpoint | JudgeV1;
  readonly registry?: Readonly<Record<string, RegistryEntry>>;
  readonly sources?: readonly PluginRef[];
  readonly sinks?: readonly SinkRef[];
  readonly thresholds?: ThresholdsPolicy;
  readonly watch?: WatchConfig;
  readonly gate?: GateConfig;
  readonly cacheDir?: string;
}

export interface ResolvedConfig {
  readonly generator?: GeneratorEndpoint | GeneratorAdapter;
  readonly judge: JudgeEndpoint | JudgeV1;
  readonly sources: readonly PluginRef[];
  readonly sinks: readonly SinkRef[];
  readonly thresholds: { default: number; perCriterion: Record<string, number> };
  readonly watch: { sampleRate?: number; upstreamSampleRate?: number; maxInFlight: number };
  readonly gate: { minPass?: number; requireCalibrated: boolean; allowUnpinned: boolean };
  readonly cacheDir: string;
}

export interface ConfigIssue {
  /** RFC 6901 JSON pointer into the config object. */
  readonly pointer: string;
  readonly message: string;
}

const DEFAULT_CACHE_DIR = '.vet';
const DEFAULT_THRESHOLD = 0.5;
const DEFAULT_MAX_IN_FLIGHT = 4;

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function escapePointer(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1');
}

// An object carrying specVersion is an adapter object: only its JSON-visible identity goes to
// the schema, so methods and vendor clients (possibly cyclic) never reach ajv.
function project(value: unknown, keys: readonly string[]): unknown {
  if (!isRecord(value) || !('specVersion' in value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (value[key] !== undefined) out[key] = value[key];
  }
  return out;
}

const ADAPTER_KEYS = ['specVersion', 'id', 'capabilities'] as const;
const PLUGIN_KEYS = ['specVersion', 'id'] as const;

function projectConfig(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...input };
  for (const key of ['judge', 'generator']) {
    if (key in out) out[key] = project(out[key], ADAPTER_KEYS);
  }
  if (isRecord(out['registry'])) {
    out['registry'] = Object.fromEntries(
      Object.entries(out['registry']).map(([name, entry]) => [name, project(entry, ADAPTER_KEYS)]),
    );
  }
  for (const key of ['sources', 'sinks']) {
    const list = out[key];
    if (Array.isArray(list)) out[key] = list.map((item: unknown) => project(item, PLUGIN_KEYS));
  }
  return out;
}

// A top-level `required` or `additionalProperties` error is worded for the config author;
// every other error keeps ajv's message under the offending pointer.
function issueMessage(err: Record<string, unknown>, topLevel: boolean, fallback: string): string {
  if (err['keyword'] === 'required' && topLevel) return 'is required';
  if (err['keyword'] === 'additionalProperties') {
    return topLevel ? 'is not a known config key' : 'is not an allowed key';
  }
  return typeof err['message'] === 'string' ? err['message'] : fallback;
}

function ajvIssues(cause: unknown, fallback: string): ConfigIssue[] {
  if (!Array.isArray(cause)) return [{ pointer: '', message: fallback }];
  const issues: ConfigIssue[] = [];
  for (const err of cause) {
    if (!isRecord(err)) continue;
    const instancePath = typeof err['instancePath'] === 'string' ? err['instancePath'] : '';
    const params = isRecord(err['params']) ? err['params'] : {};
    const extra =
      typeof params['missingProperty'] === 'string'
        ? params['missingProperty']
        : typeof params['additionalProperty'] === 'string'
          ? params['additionalProperty']
          : undefined;
    const pointer = `${instancePath}${extra === undefined ? '' : `/${escapePointer(extra)}`}`;
    issues.push({ pointer, message: issueMessage(err, instancePath === '', fallback) });
  }
  return issues.length > 0 ? issues : [{ pointer: '', message: fallback }];
}

// One pass over the whole document with every error collected, so a field with several
// problems reports each of them; identical lines (a nested oneOf can repeat one) are dropped.
function schemaIssues(input: Record<string, unknown>): ConfigIssue[] {
  const result = validateJson(input, configSchema, { allErrors: true });
  if (result.ok) return [];
  const seen = new Set<string>();
  return ajvIssues(result.error.cause, result.error.message).filter((issue) => {
    const id = `${issue.pointer}\u0000${issue.message}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

type Role = 'judge' | 'generator';

const ROLE_METHOD: Record<Role, string> = { judge: 'doJudge', generator: 'doGenerate' };

// Fields only one endpoint shape carries, keyed by the role that owns them; a plain
// {kind, baseURL, apiKeyEnv, model} suits both roles.
const ROLE_EXCLUSIVE_FIELDS: Record<Role, readonly string[]> = {
  judge: ['preset', 'accountId', 'providerOptions'],
  generator: ['structured'],
};

// Returns the resolved role value, or an issue explaining why it cannot be resolved.
function resolveRole<R extends Role>(
  config: VetkitConfig,
  role: R,
): { value?: RoleValue<R>; issue?: ConfigIssue } {
  const raw = config[role];
  if (raw === undefined) return {};
  const pointer = `/${role}`;
  let value: unknown = raw;
  if (typeof raw === 'string') {
    const entry = config.registry?.[raw];
    if (entry === undefined) {
      return {
        issue: { pointer, message: `unknown adapter "${raw}": not declared in registry` },
      };
    }
    value = entry;
    const foreign = ROLE_EXCLUSIVE_FIELDS[role === 'judge' ? 'generator' : 'judge'];
    const field = isRecord(entry) ? foreign.find((f) => entry[f] !== undefined) : undefined;
    if (field !== undefined) {
      return {
        issue: {
          pointer,
          message: `registry entry "${raw}" (/registry/${escapePointer(raw)}) is used as the ${role} but carries "${field}", which only the other role accepts`,
        },
      };
    }
  }
  if (isRecord(value) && 'specVersion' in value) {
    const method = ROLE_METHOD[role];
    if (typeof value[method] !== 'function') {
      return { issue: { pointer, message: `${role} adapter object must implement ${method}()` } };
    }
  }
  // Schema-validated above: an endpoint or an adapter object carrying the role's method.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return { value: value as RoleValue<R> };
}

// A judge endpoint names either an opaque preset (the adapter validates the name and fills in
// baseURL/model) or an explicit baseURL and model. Core never enumerates preset names.
function endpointIssue(value: unknown, pointer: string): ConfigIssue | undefined {
  if (!isRecord(value) || 'specVersion' in value) return undefined;
  if (value['preset'] !== undefined) return undefined;
  if (value['baseURL'] !== undefined && value['model'] !== undefined) return undefined;
  return { pointer, message: 'endpoint needs a preset, or a baseURL and a model' };
}

/** Every problem with `input` as a JSON-pointer issue; empty when the config is valid. */
export function validateConfig(input: unknown): ConfigIssue[] {
  if (!isRecord(input)) return [{ pointer: '', message: 'config must be an object' }];
  const issues = schemaIssues(projectConfig(input));
  if (issues.length > 0) return issues;
  const judgeIssue = endpointIssue(input['judge'], '/judge');
  if (judgeIssue !== undefined) issues.push(judgeIssue);
  if (isRecord(input['registry'])) {
    for (const [name, entry] of Object.entries(input['registry'])) {
      const issue = endpointIssue(entry, `/registry/${escapePointer(name)}`);
      if (issue !== undefined) issues.push(issue);
    }
  }
  if (issues.length > 0) return issues;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const config = input as unknown as VetkitConfig;
  for (const role of ['judge', 'generator'] as const) {
    const { issue } = resolveRole(config, role);
    if (issue !== undefined) issues.push(issue);
  }
  return issues;
}

function configError(issues: readonly ConfigIssue[]): VetError {
  const lines = issues.map((i) => `  ${i.pointer === '' ? '/' : i.pointer}: ${i.message}`);
  return new VetError(
    CEV_ERROR_CODES.CONFIG_INVALID,
    `Invalid vetkit config:\n${lines.join('\n')}`,
    {
      cause: issues,
    },
  );
}

/** Identity with validation: throws VetError CONFIG_INVALID listing every issue. */
export function defineConfig<T extends VetkitConfig>(config: T): T {
  const issues = validateConfig(config);
  if (issues.length > 0) throw configError(issues);
  return config;
}

export interface ResolveConfigResult {
  readonly config: ResolvedConfig;
  readonly warnings: readonly string[];
}

/** Validates, resolves registry names and applies defaults. */
export function resolveConfig(input: unknown): ResolveConfigResult {
  const issues = validateConfig(input);
  if (issues.length > 0) throw configError(issues);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const config = input as VetkitConfig;
  const warnings: string[] = [];

  // validateConfig guarantees judge resolves; generator may be absent.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const judge = resolveRole(config, 'judge').value as JudgeEndpoint | JudgeV1;
  const generator = resolveRole(config, 'generator').value;

  const thresholdDefault = config.thresholds?.default;
  if (thresholdDefault === undefined) {
    warnings.push(
      `thresholds.default is ${String(DEFAULT_THRESHOLD)}, a placeholder until calibrated`,
    );
  }

  const watch: ResolvedConfig['watch'] = {
    maxInFlight: config.watch?.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT,
    ...(config.watch?.sampleRate === undefined ? {} : { sampleRate: config.watch.sampleRate }),
    ...(config.watch?.upstreamSampleRate === undefined
      ? {}
      : { upstreamSampleRate: config.watch.upstreamSampleRate }),
  };
  const gate: ResolvedConfig['gate'] = {
    requireCalibrated: config.gate?.requireCalibrated ?? true,
    allowUnpinned: config.gate?.allowUnpinned ?? false,
    ...(config.gate?.minPass === undefined ? {} : { minPass: config.gate.minPass }),
  };

  return {
    config: {
      ...(generator === undefined ? {} : { generator }),
      judge,
      sources: config.sources ?? [],
      sinks: config.sinks ?? [],
      thresholds: {
        default: thresholdDefault ?? DEFAULT_THRESHOLD,
        perCriterion: { ...config.thresholds?.perCriterion },
      },
      watch,
      gate,
      cacheDir: config.cacheDir ?? DEFAULT_CACHE_DIR,
    },
    warnings,
  };
}

/** Value of env var `name`; throws VetError naming the variable (never its value) if unset/empty. */
export function readEnvName(
  name: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const value = env[name];
  if (value === undefined || value === '') {
    throw new VetError(
      CEV_ERROR_CODES.CONFIG_INVALID,
      `Environment variable ${name} is not set (named by the config)`,
    );
  }
  return value;
}

function describeRole(
  value: ResolvedConfig['judge'] | GeneratorAdapter | GeneratorEndpoint,
): string {
  if ('specVersion' in value) {
    const model = 'model' in value.capabilities ? ` model ${String(value.capabilities.model)}` : '';
    return `adapter ${value.id}${model}`;
  }
  const preset = 'preset' in value && value.preset !== undefined ? ` preset ${value.preset}` : '';
  const model = value.model === undefined ? '' : ` model ${value.model}`;
  const at = value.baseURL === undefined ? '' : ` at ${value.baseURL}`;
  return `${value.kind}${preset}${model}${at} (key from $${value.apiKeyEnv})`;
}

function describeRefs(refs: readonly (PluginRef | SinkDescriptor)[]): string {
  return refs.length === 0
    ? 'none'
    : refs.map((r) => (typeof r === 'string' ? r : 'kind' in r ? r.kind : r.id)).join(', ');
}

/** Human-readable lines for `vet doctor --config`; names env vars, never key values or options. */
export function describeConfig(config: ResolvedConfig): string[] {
  const { thresholds, watch, gate } = config;
  const overrides = Object.keys(thresholds.perCriterion).length;
  return [
    `judge: ${describeRole(config.judge)}`,
    `generator: ${config.generator === undefined ? 'none' : describeRole(config.generator)}`,
    `sources: ${describeRefs(config.sources)}`,
    `sinks: ${describeRefs(config.sinks)}`,
    `thresholds: default ${String(thresholds.default)}, ${String(overrides)} per-criterion override(s)`,
    `watch: maxInFlight ${String(watch.maxInFlight)}, sampleRate ${String(watch.sampleRate ?? 'unset')}, upstreamSampleRate ${String(watch.upstreamSampleRate ?? 'unset')}`,
    `gate: minPass ${String(gate.minPass ?? 'unset')}, requireCalibrated ${String(gate.requireCalibrated)}, allowUnpinned ${String(gate.allowUnpinned)}`,
    `cacheDir: ${config.cacheDir}`,
  ];
}
