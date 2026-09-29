import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { VetError, type JudgeV1 } from '@vetkit/spec';
import {
  defineConfig,
  describeConfig,
  readEnvName,
  resolveConfig,
  validateConfig,
  type ConfigIssue,
  type VetkitConfig,
} from './config.ts';

const judgeEndpoint = {
  kind: 'typesafe-compatible',
  baseURL: 'https://judge.example.test/v1',
  apiKeyEnv: 'JUDGE_KEY',
  model: 'acme/judge-1',
} as const;

const minimal: VetkitConfig = { judge: judgeEndpoint };

// Feeds defineConfig shapes its static type rejects, as a JS config file would at load time.
function defineUntyped(input: unknown): unknown {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return defineConfig(input as VetkitConfig);
}

function fakeJudge(): JudgeV1 {
  return {
    specVersion: 'v1',
    id: 'fake-judge',
    capabilities: {
      questionTypes: ['boolean'],
      maxStateTokens: 1000,
      pinned: false,
      transport: 'fake',
      model: 'acme/judge-1',
    },
    doJudge: () => Promise.reject(new Error('not called')),
  };
}

function issuesOf(fn: () => unknown): ConfigIssue[] {
  try {
    fn();
  } catch (error) {
    expect(VetError.isInstance(error)).toBe(true);
    if (!VetError.isInstance(error)) throw error;
    expect(error.code).toBe('CONFIG_INVALID');
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return error.cause as ConfigIssue[];
  }
  throw new Error('expected a CONFIG_INVALID VetError');
}

describe('defineConfig / validateConfig', () => {
  it('accepts a minimal valid config and returns it unchanged', () => {
    expect(defineConfig(minimal)).toBe(minimal);
    expect(validateConfig(minimal)).toEqual([]);
  });

  it('accepts every documented field together', () => {
    const full: VetkitConfig = {
      generator: {
        kind: 'openai-compatible',
        baseURL: 'https://gen.example.test/v1',
        apiKeyEnv: 'GEN_KEY',
        model: 'acme/gen-1',
      },
      judge: { ...judgeEndpoint, providerOptions: { temperature: 0 } },
      sources: ['traces'],
      sinks: ['report'],
      thresholds: { default: 0.7, perCriterion: { promised_refund: 0.9 } },
      watch: { sampleRate: 0.1, upstreamSampleRate: 0.5, maxInFlight: 2 },
      gate: { minPass: 0.8, requireCalibrated: false, allowUnpinned: true },
      cacheDir: '.cache/vet',
    };
    expect(validateConfig(full)).toEqual([]);
  });

  it('accepts a judge adapter object', () => {
    expect(validateConfig({ judge: fakeJudge() })).toEqual([]);
  });

  it('rejects a config without judge, naming judge (never a default provider)', () => {
    const issues = issuesOf(() => defineUntyped({}));
    expect(issues.map((i) => i.pointer)).toContain('/judge');
  });

  it('rejects watch.sampleRate 1.5 at /watch/sampleRate', () => {
    const issues = issuesOf(() => defineUntyped({ ...minimal, watch: { sampleRate: 1.5 } }));
    expect(issues.map((i) => i.pointer)).toContain('/watch/sampleRate');
  });

  it('rejects an unknown top-level key (typo protection)', () => {
    const issues = issuesOf(() => defineUntyped({ ...minimal, judeg: 'x' }));
    expect(issues.map((i) => i.pointer)).toContain('/judeg');
  });

  it('lists an issue for every invalid top-level field, each with a message', () => {
    const issues = issuesOf(() =>
      defineUntyped({
        ...minimal,
        cacheDir: 3,
        gate: { allowUnpinned: 'yes' },
        typo: true,
      }),
    );
    const pointers = issues.map((i) => i.pointer);
    expect(pointers).toContain('/cacheDir');
    expect(pointers).toContain('/gate/allowUnpinned');
    expect(pointers).toContain('/typo');
    for (const issue of issues) expect(issue.message.length).toBeGreaterThan(0);
  });

  it('puts every pointer and message into the error message', () => {
    try {
      defineUntyped({ ...minimal, watch: { sampleRate: 1.5 } });
    } catch (error) {
      expect(String(error)).toContain('/watch/sampleRate');
      return;
    }
    throw new Error('expected a throw');
  });

  it('rejects a judge endpoint missing model', () => {
    const { model: _model, ...noModel } = judgeEndpoint;
    const issues = issuesOf(() => defineUntyped({ judge: noModel }));
    expect(issues.some((i) => i.pointer.startsWith('/judge'))).toBe(true);
  });
});

describe('judge endpoint presets', () => {
  it('accepts a preset with accountId and no baseURL or model', () => {
    const judge = {
      kind: 'typesafe-compatible',
      preset: 'cloudflare',
      accountId: 'abc',
      apiKeyEnv: 'CLOUDFLARE_API_TOKEN',
    };
    expect(validateConfig({ judge })).toEqual([]);
  });

  it('accepts a preset without accountId', () => {
    const judge = {
      kind: 'typesafe-compatible',
      preset: 'vercel',
      apiKeyEnv: 'AI_GATEWAY_API_KEY',
    };
    expect(validateConfig({ judge })).toEqual([]);
  });

  it('rejects an endpoint with neither preset nor baseURL at /judge', () => {
    const { baseURL: _baseURL, ...noBase } = judgeEndpoint;
    const issues = issuesOf(() => defineUntyped({ judge: noBase }));
    expect(issues.map((i) => i.pointer)).toContain('/judge');
  });

  it('still accepts baseURL without preset', () => {
    expect(validateConfig({ judge: judgeEndpoint })).toEqual([]);
  });

  it('describes a preset judge by preset name without any key value', () => {
    const { config } = resolveConfig({
      judge: {
        kind: 'typesafe-compatible',
        preset: 'cloudflare',
        accountId: 'abc',
        apiKeyEnv: 'CLOUDFLARE_API_TOKEN',
        providerOptions: { secretish: 'sk-do-not-print' },
      },
    });
    const text = describeConfig(config).join('\n');
    expect(text).toContain('cloudflare');
    expect(text).toContain('CLOUDFLARE_API_TOKEN');
    expect(text).not.toContain('sk-do-not-print');
  });

  it('core config.ts and config.schema.json name no vendor outside comments', () => {
    const vendor = /vercel|typesafe|openrouter|cloudflare/i;
    const ts = readFileSync(new URL('config.ts', import.meta.url), 'utf8')
      .replaceAll(/\/\*[\s\S]*?\*\//g, '')
      .replaceAll(/\/\/.*$/gm, '');
    const schema = readFileSync(
      new URL('../../spec/schemas/config.schema.json', import.meta.url),
      'utf8',
    );
    expect(ts).not.toMatch(vendor);
    expect(schema).not.toMatch(vendor);
  });
});

// Declarative sink descriptors ({kind:'otel'|'langfuse', *Env}) resolved by the CLI, alongside
// adapter objects.
describe('sink descriptors', () => {
  const otelDescriptor = {
    kind: 'otel',
    endpoint: 'https://collector.example.test',
    headersEnv: 'OTEL_HEADERS',
  };
  const otelDescriptorNoHeaders = { kind: 'otel', endpoint: 'https://collector.example.test' };
  const langfuseDescriptor = {
    kind: 'langfuse',
    baseUrlEnv: 'LF_BASE_URL',
    publicKeyEnv: 'LF_PUBLIC_KEY',
    secretKeyEnv: 'LF_SECRET_KEY',
  };

  it('accepts an otel sink descriptor with headersEnv', () => {
    expect(validateConfig({ ...minimal, sinks: [otelDescriptor] })).toEqual([]);
  });

  it('accepts an otel sink descriptor without headersEnv', () => {
    expect(validateConfig({ ...minimal, sinks: [otelDescriptorNoHeaders] })).toEqual([]);
  });

  it('accepts a langfuse sink descriptor', () => {
    expect(validateConfig({ ...minimal, sinks: [langfuseDescriptor] })).toEqual([]);
  });

  it('rejects a langfuse descriptor missing secretKeyEnv at /sinks/0/secretKeyEnv', () => {
    const { secretKeyEnv: _secretKeyEnv, ...broken } = langfuseDescriptor;
    const issues = issuesOf(() => defineUntyped({ ...minimal, sinks: [broken] }));
    expect(issues).toContainEqual(expect.objectContaining({ pointer: '/sinks/0/secretKeyEnv' }));
  });

  it('rejects an unknown descriptor key', () => {
    const issues = issuesOf(() =>
      defineUntyped({ ...minimal, sinks: [{ ...otelDescriptor, extra: true }] }),
    );
    expect(issues.some((i) => i.pointer.startsWith('/sinks'))).toBe(true);
  });

  it('describeConfig names an otel sink descriptor by its kind', () => {
    const { config } = resolveConfig({ ...minimal, sinks: [otelDescriptor] });
    expect(describeConfig(config).join('\n')).toContain('otel');
  });
});

describe('resolveConfig', () => {
  it('applies the documented defaults', () => {
    const { config } = resolveConfig(minimal);
    expect(config.cacheDir).toBe('.vet');
    expect(config.thresholds.default).toBe(0.5);
    expect(config.thresholds.perCriterion).toEqual({});
    expect(config.gate.requireCalibrated).toBe(true);
    expect(config.gate.allowUnpinned).toBe(false);
    expect(config.watch.maxInFlight).toBe(4);
    expect(config.sources).toEqual([]);
    expect(config.sinks).toEqual([]);
    expect(config.judge).toEqual(judgeEndpoint);
  });

  it('warns that the default threshold is a placeholder until calibrated', () => {
    const { warnings } = resolveConfig(minimal);
    expect(warnings.some((w) => w.includes('placeholder'))).toBe(true);
  });

  it('does not warn about the threshold when thresholds.default is set', () => {
    const { warnings } = resolveConfig({ ...minimal, thresholds: { default: 0.6 } });
    expect(warnings.some((w) => w.includes('placeholder'))).toBe(false);
  });

  it('keeps explicit values over defaults', () => {
    const { config } = resolveConfig({
      ...minimal,
      cacheDir: 'x',
      gate: { requireCalibrated: false },
      watch: { maxInFlight: 9 },
    });
    expect(config.cacheDir).toBe('x');
    expect(config.gate.requireCalibrated).toBe(false);
    expect(config.gate.allowUnpinned).toBe(false);
    expect(config.watch.maxInFlight).toBe(9);
  });

  it('resolves a judge string through the user-declared registry', () => {
    const { config } = resolveConfig({ judge: 'mine', registry: { mine: judgeEndpoint } });
    expect(config.judge).toEqual(judgeEndpoint);
  });

  it('resolves a generator string through the registry', () => {
    const generator = { ...judgeEndpoint, kind: 'openai-compatible' };
    const { config } = resolveConfig({
      ...minimal,
      generator: 'gen',
      registry: { gen: generator },
    });
    expect(config.generator).toEqual(generator);
  });

  it('resolveConfig keeps generator.structured', () => {
    const generator = {
      kind: 'openai-compatible',
      baseURL: 'https://gen.example/v1',
      apiKeyEnv: 'MY_GEN_KEY',
      model: 'gen-model',
      structured: 'json_object',
    } as const;
    expect(resolveConfig({ ...minimal, generator }).config.generator).toEqual(generator);
  });

  it('validateConfig reports /generator/structured for an unknown value', () => {
    const generator = {
      kind: 'openai-compatible',
      baseURL: 'https://gen.example/v1',
      apiKeyEnv: 'MY_GEN_KEY',
      model: 'gen-model',
      structured: 'tool',
    };
    const issues = validateConfig({ ...minimal, generator });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((i) => i.pointer.startsWith('/generator'))).toBe(true);
  });

  it('rejects a judge string absent from the registry, never picking a default', () => {
    const issues = issuesOf(() => resolveConfig({ judge: 'jev' }));
    expect(issues.map((i) => i.pointer)).toContain('/judge');
    expect(issues.find((i) => i.pointer === '/judge')?.message).toContain('jev');
  });

  it('keeps a judge adapter object as-is', () => {
    const judge = fakeJudge();
    expect(resolveConfig({ judge }).config.judge).toBe(judge);
  });

  it('rejects a judge adapter object without doJudge', () => {
    const { specVersion, id, capabilities } = fakeJudge();
    const broken = { specVersion, id, capabilities };
    const issues = issuesOf(() => resolveConfig({ judge: broken }));
    expect(issues.map((i) => i.pointer)).toContain('/judge');
  });

  it('throws CONFIG_INVALID for invalid input', () => {
    const issues = issuesOf(() => resolveConfig({ ...minimal, watch: { sampleRate: -1 } }));
    expect(issues.map((i) => i.pointer)).toContain('/watch/sampleRate');
  });
});

describe('readEnvName', () => {
  it('returns the value of a set variable', () => {
    expect(readEnvName('MY_KEY', { MY_KEY: 'v' })).toBe('v');
  });

  it('throws naming the variable when it is unset or empty', () => {
    for (const env of [{}, { MY_KEY: '' }]) {
      try {
        readEnvName('MY_KEY', env);
      } catch (error) {
        expect(VetError.isInstance(error)).toBe(true);
        expect(String(error)).toContain('MY_KEY');
        continue;
      }
      throw new Error('expected a throw');
    }
  });
});

describe('describeConfig', () => {
  it('names the judge, its key variable and the cache dir without any key value', () => {
    const { config } = resolveConfig({
      ...minimal,
      judge: { ...judgeEndpoint, providerOptions: { secretish: 'sk-do-not-print' } },
    });
    const text = describeConfig(config).join('\n');
    expect(text).toContain('typesafe-compatible');
    expect(text).toContain('acme/judge-1');
    expect(text).toContain('JUDGE_KEY');
    expect(text).toContain('.vet');
    expect(text).not.toContain('sk-do-not-print');
  });

  it('describes an adapter-object judge by id', () => {
    const { config } = resolveConfig({ judge: fakeJudge() });
    expect(describeConfig(config).join('\n')).toContain('fake-judge');
  });
});
