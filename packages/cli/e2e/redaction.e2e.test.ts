// Canary e2e: `vet run` with a canary key in every provider key env var, over the fake judge
// fixture, must leave 0 hits of the canary in .vet/ (runs, cache, records), stdout, stderr,
// the JUnit file and the --json document. Needs no network; runs the built dist/bin.js.
// The fixture judge cannot carry a request header, so the header path is covered in
// packages/cli/src/redact.test.ts.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, test } from 'vitest';
import { ensureCliBuilt } from '../src/test-support/build-cli.js';

const binPath = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
const fixtureDir = fileURLToPath(new URL('../../../fixtures/cli/run', import.meta.url));
const CANARY = 'vetkit-canary-0f9e8d7c6b5a4938';

beforeAll(async () => {
  await ensureCliBuilt();
}, 180_000);

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

describe('redaction canary', () => {
  test.each([
    ['plain', ['run', '--verbose', '--reporter', 'junit']],
    ['json', ['run', '--verbose', '--json', '--reporter', 'junit']],
  ] as const)('vet run (%s): canary appears in no artifact', (_label, args) => {
    const project = mkdtempSync(join(tmpdir(), 'vetkit-canary-'));
    cpSync(fixtureDir, project, { recursive: true });
    const result = spawnSync(process.execPath, [binPath, ...args], {
      cwd: project,
      encoding: 'utf8',
      env: {
        ...process.env,
        NO_COLOR: '1',
        VETKIT_FIXTURE_MODE: 'pass',
        VETKIT_FIXTURE_KEY: CANARY,
        AI_GATEWAY_API_KEY: CANARY,
        OPENROUTER_API_KEY: CANARY,
        TYPESAFE_API_KEY: CANARY,
      },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain(CANARY);
    expect(result.stderr).not.toContain(CANARY);
    const files = filesUnder(project);
    expect(files.some((file) => file.endsWith('junit.xml'))).toBe(true);
    expect(files.some((file) => file.includes(join('.vet', 'runs')))).toBe(true);
    const hits = files.filter((file) => readFileSync(file, 'utf8').includes(CANARY));
    expect(hits.map((file) => relative(project, file))).toEqual([]);
  });
});
