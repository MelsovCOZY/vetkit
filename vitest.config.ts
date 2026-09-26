import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// `setupFiles` must be absolute: package projects below set their own `root`
// (packages/<name>), so a relative './vitest.setup.ts' would resolve against
// each package directory instead of the repo root.
const setupFile = fileURLToPath(new URL('./vitest.setup.ts', import.meta.url));

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
      // The named verify command for generated type tests (e.g. generated.test-d.ts)
      // needs this enabled per-package, or vitest reports "No test files found" and
      // exits 0 without type-checking anything.
      typecheck: {
        enabled: true,
        include: ['**/*.test-d.ts'],
      },
    },
  }));

export default defineConfig({
  test: {
    // Empty `packages/*` projects (no tests yet - each package's own bead adds them)
    // must not fail the run; scripts/spike below always have test files, so this is
    // a safety net for the packages-only case, not something exercised today.
    passWithNoTests: true,
    restoreMocks: true,
    clearMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    setupFiles: [setupFile],
    coverage: {
      provider: 'v8',
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
    ],
  },
});
