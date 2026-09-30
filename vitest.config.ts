import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

// `setupFiles` must be absolute: package projects below set their own `root`
// (packages/<name>), so a relative './vitest.setup.ts' would resolve against
// each package directory instead of the repo root.
const setupFile = fileURLToPath(new URL('./vitest.setup.ts', import.meta.url));

const repoRoot = fileURLToPath(new URL('.', import.meta.url));
const cliGlobalSetup = fileURLToPath(
  new URL('./packages/cli/src/test-support/global-setup.ts', import.meta.url),
);

// Cross-package imports (e.g. packages/cli/src/errors.ts importing @vetkit/spec) resolve
// through each workspace package's package.json `exports`, which point at ./dist — build
// output that doesn't exist before `bun run build`. Alias every @vetkit/<name> workspace
// package straight to its source entry point instead, mirroring the tsconfig `paths`
// precedent (packages/cli/tsconfig.json), so tests behave like tsc: no build required.
// Derived from packages/*/package.json so new packages are covered automatically; the
// cli package (npm name "vetkit", not scoped) is naturally excluded.
const packageAliases = Object.fromEntries(
  readdirSync(join(repoRoot, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const pkgJson: { name: string } = JSON.parse(
        readFileSync(join(repoRoot, 'packages', entry.name, 'package.json'), 'utf8'),
      );
      return { name: pkgJson.name, dir: entry.name };
    })
    .filter(({ name }) => name.startsWith('@vetkit/'))
    .map(({ name, dir }) => [name, join(repoRoot, 'packages', dir, 'src', 'index.ts')]),
);

// A bare `packages/*` glob project does NOT inherit root `test` options (setupFiles,
// restoreMocks, etc.) - each matched directory becomes an independent project that only
// picks up its own vite/vitest config, if any. Building one inline project per package
// with `extends: true` fixes that, while keeping the project name equal to the package
// directory name (spec, core, cli, ...) so `--project <name>` still works.
const packageProjects = readdirSync('packages', { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => ({
    extends: true,
    root: `packages/${entry.name}`,
    test: {
      name: entry.name,
      // The cli tests spawn packages/cli/dist/bin.js; build its workspace chain once per
      // run here, before any worker starts, instead of from inside the tests.
      globalSetup: entry.name === 'cli' ? [cliGlobalSetup] : [],
      // Type tests (e.g. generated.test-d.ts) need this enabled per package, or vitest
      // reports "No test files found" and exits 0 without type-checking anything.
      typecheck: {
        enabled: true,
        include: ['**/*.test-d.ts'],
      },
      // e2e/** is the e2e project's territory only (see below); without this, a
      // package's default project silently collects and skips its own e2e journey
      // test instead of leaving it to `--project e2e`.
      exclude: [...configDefaults.exclude, '**/e2e/**'],
    },
  }));

export default defineConfig({
  resolve: {
    alias: packageAliases,
  },
  test: {
    // Empty `packages/*` projects (no tests yet)
    // must not fail the run; scripts/spike below always have test files, so this is
    // a safety net for the packages-only case.
    passWithNoTests: true,
    // One temp root per run, removed when the run ends. Absolute for the same reason as
    // `setupFiles` above: package projects set their own `root`.
    globalSetup: [join(repoRoot, 'vitest.global-setup.ts')],
    restoreMocks: true,
    clearMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    setupFiles: [setupFile],
    coverage: {
      provider: 'v8',
      // Package sources only. Without `include`, every file a test loads is counted -
      // the built packages/*/dist/*.js that CLI tests spawn or import, fixture and
      // example configs - and sources no test loads are left out. Test files are
      // excluded by vitest itself.
      include: ['packages/*/src/**/*.ts'],
      // Type tests are only type-checked, never executed, so v8 would report them at 0%.
      exclude: ['**/*.test-d.ts'],
      // Enforced by `bun run test`, which runs with --coverage.
      thresholds: { lines: 83, branches: 76, functions: 82, statements: 82 },
    },
    projects: [
      ...packageProjects,
      {
        extends: true,
        test: {
          name: 'scripts',
          include: ['scripts/**/*.test.ts'],
          typecheck: {
            enabled: true,
            include: ['scripts/**/*.test-d.ts'],
          },
        },
      },
      {
        extends: true,
        test: {
          name: 'spike',
          include: ['spike/**/*.test.ts'],
        },
      },
      // Smokes against the real Jev endpoint. Opt-in only: without
      // CEV_E2E=1, `bun run test` must not collect e2e/** (or packages/*/e2e/**) at
      // all (the fetch guard in vitest.setup.ts already lets CEV_E2E=1 tests
      // through). These smokes can take minutes, hence the long timeout.
      ...(process.env.CEV_E2E === '1'
        ? [
            {
              extends: true,
              test: {
                name: 'e2e',
                include: ['e2e/**/*.e2e.test.ts', 'packages/*/e2e/**/*.e2e.test.ts'],
                testTimeout: 900_000,
              },
            },
          ]
        : []),
    ],
  },
});
