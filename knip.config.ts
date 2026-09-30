import type { KnipConfig } from 'knip';

const config: KnipConfig = {
  workspaces: {
    '.': {
      entry: ['scripts/**/*.{ts,mjs}', 'spike/**/*.ts', 'e2e/**/*.ts', 'action/*.mjs'],
      project: ['scripts/**', 'spike/**', 'e2e/**', 'action/**', '*.ts'],
      // Tools run as CLIs from scripts (pack.ts, consumer-matrix.sh, smoke-j0.sh) or kept
      // as catalog-pinned versions that manifests.test.ts asserts; knip cannot see either.
      // spike/label.test.ts spawns `bun spike/label.ts`; knip reads that path as an import.
      ignoreUnresolved: ['spike/label.ts'],
      ignoreDependencies: [
        'typescript6',
        '@arethetypeswrong/cli',
        'validate-package-exports',
        '@standard-schema/spec',
        'picocolors',
      ],
    },
    'packages/cli': {
      entry: ['e2e/**/*.ts'],
      // e2e tests pass `watch` and `check` as vet subcommand args to spawn; not binaries.
      ignoreBinaries: ['watch', 'check'],
    },
    'packages/scorers': {
      // Optional peer, deliberately not a hard dependency.
      ignoreDependencies: ['vitest'],
    },
    'packages/export-vitest': {
      // evalite: peer of the optional integration; dev-installed so its types resolve.
      // vitest: optional peer, deliberately not a hard dependency.
      ignoreDependencies: ['evalite', 'vitest'],
    },
    'packages/judge-jev': {
      // Loaded by dynamic specifier in src/transport.ts, so knip sees no static import.
      ignoreDependencies: ['@typesafe-ai/sdk'],
    },
    'packages/sink-langfuse': { ignoreDependencies: ['langfuse'] },
    'packages/source-langfuse': { ignoreDependencies: ['langfuse'] },
  },
  // Test shim: emit-scorer.test.ts maps the bare `vetkit` specifier to this file by path string.
  ignoreIssues: { 'packages/cli/src/judge-one.ts': ['exports'] },
  // examples/ are consumer projects with their own package.json, run by scripts/examples-run.sh.
  // Codegen output (bun run codegen; CI diffs it): every schema type is emitted, used or not.
  ignore: ['packages/spec/src/generated/**', 'examples/**'],
  // Version pool asserted by scripts/manifests.test.ts; packages do not reference it yet.
  exclude: ['catalog'],
};

export default config;
