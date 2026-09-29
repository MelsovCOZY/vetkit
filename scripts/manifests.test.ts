import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES_DIR = join(ROOT, 'packages');
const FORBIDDEN = ['ai', '@types/bun', 'bun-types'];

function readJson(path: string): any {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
}

const rootPkg = readJson(join(ROOT, 'package.json'));

const packageNames = existsSync(PACKAGES_DIR)
  ? readdirSync(PACKAGES_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
  : [];

function loadPkg(dir: string): any {
  return readJson(join(PACKAGES_DIR, dir, 'package.json'));
}

function externalDeps(pkg: any): string[] {
  return Object.keys(pkg?.dependencies ?? {}).filter((k) => !k.startsWith('@vetkit/'));
}

function externalPeers(pkg: any): string[] {
  return Object.keys(pkg?.peerDependencies ?? {}).filter((k) => !k.startsWith('@vetkit/'));
}

function allDeclaredDeps(pkg: any): Record<string, string> {
  return { ...pkg?.dependencies, ...pkg?.devDependencies, ...pkg?.peerDependencies };
}

describe('root package.json', () => {
  it('declares workspaces for packages/*', () => {
    expect(rootPkg?.workspaces).toEqual(['packages/*']);
  });

  it('pins packageManager to bun@1.4.2', () => {
    expect(rootPkg?.packageManager).toBe('bun@1.4.2');
  });

  it('is private', () => {
    expect(rootPkg?.private).toBe(true);
  });

  it('requires node >=22.12', () => {
    expect(rootPkg?.engines?.node).toBe('>=22.12');
  });

  it('declares a non-empty catalog of shared devDependency versions', () => {
    expect(typeof rootPkg?.catalog).toBe('object');
    expect(Object.keys(rootPkg?.catalog ?? {}).length).toBeGreaterThan(0);
  });

  it('declares the contract script names', () => {
    const names = ['typecheck', 'lint', 'fmt', 'fmt:write', 'test', 'build', 'pack', 'check', 'codegen'];
    for (const name of names) {
      expect(rootPkg?.scripts).toHaveProperty(name);
    }
  });

  it('lint script runs oxlint --type-aware and scripts/ban-raw-json-parse.sh', () => {
    const lintScript = rootPkg?.scripts?.lint;
    expect(lintScript).toContain('oxlint --type-aware');
    expect(lintScript).toContain('scripts/ban-raw-json-parse.sh');
  });

  it('pins exact root devDependency versions from the toolchain probe', () => {
    const expected: Record<string, string> = {
      typescript: '7.0.2',
      typescript6: 'npm:@typescript/typescript6@6.0.2',
      oxlint: '1.85.0',
      oxfmt: '0.70.0',
      'oxlint-tsgolint': '7.0.2003',
      tsdown: '0.23.0',
      vitest: '5.0.2',
      '@vitest/coverage-v8': '5.0.2',
      '@changesets/cli': '3.0.3',
      publint: '0.3.24',
      '@arethetypeswrong/cli': '0.18.5',
      knip: '6.38.0',
      'validate-package-exports': '1.4.5',
      lefthook: '2.1.14',
      'json-schema-to-typescript': '16.0.0',
      '@types/node': '22.20.4',
      '@standard-schema/spec': '1.1.0',
      zod: '4.6.5',
      yaml: '2.9.1',
      '@clack/prompts': '1.8.1',
      picocolors: '1.1.1',
    };
    for (const [name, version] of Object.entries(expected)) {
      expect(rootPkg?.devDependencies?.[name]).toBe(version);
    }
  });

  it('never depends on ai, @types/bun or bun-types', () => {
    const all = allDeclaredDeps(rootPkg);
    for (const forbidden of FORBIDDEN) {
      expect(all).not.toHaveProperty(forbidden);
    }
  });
});

// The original J0 contract packages: a floor, not a ceiling (this test
// globs packages/*/package.json, it does not hard-code the package list). Packages added
// under packages/* are picked up by the dynamic describe.each below without another edit here.
const MIN_PACKAGE_NAMES = [
  'spec',
  'core',
  'cli',
  'judge-jev',
  'generator-openai-compatible',
  'source-jsonl',
  'source-otlp',
  'source-langfuse',
  'sink-otel',
  'sink-langfuse',
  'export-vitest',
];

it('creates at least the eleven original contract packages (open-world: later beads add more)', () => {
  expect(packageNames).toEqual(expect.arrayContaining(MIN_PACKAGE_NAMES));
  expect(packageNames.length).toBeGreaterThanOrEqual(MIN_PACKAGE_NAMES.length);
});

describe.each(packageNames.length ? packageNames : MIN_PACKAGE_NAMES)('packages/%s/package.json', (dir) => {
  const pkg = loadPkg(dir);

  it('has name @vetkit/<dir> (cli is named "vetkit")', () => {
    expect(pkg?.name).toBe(dir === 'cli' ? 'vetkit' : `@vetkit/${dir}`);
  });

  it('is version 0.0.0', () => {
    expect(pkg?.version).toBe('0.0.0');
  });

  it('is type module', () => {
    expect(pkg?.type).toBe('module');
  });

  it('declares sideEffects (false, except cli which lists its bin)', () => {
    if (dir === 'cli') expect(pkg?.sideEffects).toEqual(['./dist/bin.js']);
    else expect(pkg?.sideEffects).toBe(false);
  });

  it('requires node >=22.12', () => {
    expect(pkg?.engines?.node).toBe('>=22.12');
  });

  it('publishes only dist (cli also ships templates)', () => {
    if (dir === 'cli') expect(pkg?.files).toEqual(['dist', 'templates']);
    else expect(pkg?.files).toEqual(['dist']);
  });

  it('exports only types+import conditions, plus ./package.json', () => {
    expect(pkg?.exports?.['./package.json']).toBe('./package.json');
    for (const [key, value] of Object.entries(pkg?.exports ?? {})) {
      if (key === './package.json') continue;
      expect(Object.keys(value as object).sort()).toEqual(['import', 'types']);
    }
  });

  it('is publishable publicly', () => {
    expect(pkg?.publishConfig?.access).toBe('public');
  });

  it('references sibling @vetkit/* packages only via workspace:^', () => {
    const all = allDeclaredDeps(pkg);
    for (const [name, range] of Object.entries(all)) {
      if (name.startsWith('@vetkit/')) expect(range).toBe('workspace:^');
    }
  });

  it('never depends on ai, @types/bun or bun-types', () => {
    const all = allDeclaredDeps(pkg);
    for (const forbidden of FORBIDDEN) {
      expect(all).not.toHaveProperty(forbidden);
    }
  });

  it('declares scripts.build as tsdown', () => {
    expect(pkg?.scripts?.build).toBe('tsdown');
  });
});

describe('dependency budget', () => {
  it('packages/spec has exactly one external runtime dependency: ajv', () => {
    expect(externalDeps(loadPkg('spec'))).toEqual(['ajv']);
  });

  it('packages/core has exactly one external runtime dependency: yaml', () => {
    expect(externalDeps(loadPkg('core'))).toEqual(['yaml']);
  });

  it('packages/cli depends on commander, @clack/prompts, picocolors and c12', () => {
    const pkg = loadPkg('cli');
    expect(pkg?.dependencies?.commander).toBe('15.0.0');
    expect(pkg?.dependencies?.['@clack/prompts']).toBe('1.8.1');
    expect(pkg?.dependencies?.picocolors).toBe('1.1.1');
    expect(pkg?.dependencies?.c12).toBe('^3.3.4');
  });

  it('packages/cli exposes the vet binary', () => {
    expect(loadPkg('cli')?.bin).toEqual({ vet: './dist/bin.js' });
  });

  it('packages/judge-jev takes @typesafe-ai/sdk as an optional peer', () => {
    const pkg = loadPkg('judge-jev');
    expect(externalPeers(pkg)).toEqual(['@typesafe-ai/sdk']);
    expect(pkg?.peerDependenciesMeta?.['@typesafe-ai/sdk']?.optional).toBe(true);
  });

  it('packages/sink-langfuse and packages/source-langfuse take langfuse as an optional peer', () => {
    for (const dir of ['sink-langfuse', 'source-langfuse']) {
      const pkg = loadPkg(dir);
      expect(externalPeers(pkg)).toEqual(['langfuse']);
      expect(pkg?.peerDependenciesMeta?.langfuse?.optional).toBe(true);
    }
  });

  it('packages/sink-otel requires @opentelemetry/api as a non-optional peer, plus its OTel deps', () => {
    const pkg = loadPkg('sink-otel');
    expect(externalPeers(pkg)).toEqual(['@opentelemetry/api']);
    expect(pkg?.peerDependenciesMeta?.['@opentelemetry/api']?.optional).not.toBe(true);
    expect(externalDeps(pkg).sort()).toEqual(
      ['@opentelemetry/api-logs', '@opentelemetry/exporter-logs-otlp-http', '@opentelemetry/sdk-trace-base'].sort(),
    );
  });

  it('packages/export-vitest requires vitest as a non-optional peer and pins evalite exactly', () => {
    const pkg = loadPkg('export-vitest');
    expect(externalPeers(pkg)).toEqual(['vitest']);
    expect(pkg?.peerDependenciesMeta?.vitest?.optional).not.toBe(true);
    expect(pkg?.devDependencies?.evalite).toBe('1.0.0-beta.16');
  });

  it('packages/source-otlp, source-jsonl and generator-openai-compatible take no external runtime deps', () => {
    for (const dir of ['source-otlp', 'source-jsonl', 'generator-openai-compatible']) {
      const pkg = loadPkg(dir);
      expect(externalDeps(pkg)).toEqual([]);
      expect(externalPeers(pkg)).toEqual([]);
    }
  });

  it('every adapter package (source-*, sink-*, judge-*, generator-*, export-*) has at most one peer dependency', () => {
    for (const dir of packageNames.filter((d) => /^(source|sink|judge|generator|export)-/.test(d))) {
      expect(externalPeers(loadPkg(dir)).length).toBeLessThanOrEqual(1);
    }
  });

  it('packages/scorers takes no external runtime dependencies and vitest as an optional peer', () => {
    const pkg = loadPkg('scorers');
    expect(externalDeps(pkg)).toEqual([]);
    expect(externalPeers(pkg)).toEqual(['vitest']);
    expect(pkg?.peerDependenciesMeta?.vitest?.optional).toBe(true);
  });
});

describe('bun.lock', () => {
  it('never resolves ai, @types/bun or bun-types as an installed package', () => {
    // A resolved package is its own top-level lockfile entry: `"<name>": ["<name>@<version>", ...]`.
    // This deliberately does not flag a package's own (unresolved, optional) peer dependency *named*
    // "ai" appearing inside another entry's metadata (e.g. evalite's optional peer on `ai`) - that
    // string is never installed and resolves to nothing, so it is not a dependency of this tree.
    const lockPath = join(ROOT, 'bun.lock');
    expect(existsSync(lockPath)).toBe(true);
    const lock = readFileSync(lockPath, 'utf8');
    for (const forbidden of ['ai', '@types/bun', 'bun-types']) {
      const resolvedEntry = new RegExp(`"${forbidden.replace(/[/]/g, '\\/')}":\\s*\\["${forbidden.replace(/[/]/g, '\\/')}@`);
      expect(resolvedEntry.test(lock)).toBe(false);
    }
  });
});
