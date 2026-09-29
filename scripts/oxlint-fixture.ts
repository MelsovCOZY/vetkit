import { spawnSync } from 'node:child_process';
import path from 'node:path';

const rootDir = path.resolve(import.meta.dirname, '..');
const oxlintBin = path.join(rootDir, 'node_modules/.bin/oxlint');
const fixturesConfig = path.join(rootDir, 'scripts/fixtures/lint-bad/oxlintrc.fixtures.json');

// oxlint picks a CI-specific reporter (github ::error annotations, which drop the custom rule
// message) on runners; forcing `--format=default` keeps the asserted text identical everywhere.
export function runOxlintOnFixture(relativeFile: string, env: Record<string, string> = {}) {
  const result = spawnSync(oxlintBin, ['--format=default', '-c', fixturesConfig, relativeFile], {
    cwd: rootDir,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}
