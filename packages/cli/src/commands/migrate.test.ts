import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeParseJson } from '@vetkit/spec';
import { beforeAll, describe, expect, it } from 'vitest';
import { createProgram } from '../program.ts';
import { ensureCliBuilt } from '../test-support/build-cli.js';

const binPath = fileURLToPath(new URL('../../dist/bin.js', import.meta.url));
const runFixture = fileURLToPath(new URL('../../../../fixtures/cli/run/', import.meta.url));
const LINK = 'https://melsovcozy.github.io/vetkit/docs/migrate.html';

beforeAll(async () => {
  await ensureCliBuilt();
}, 180_000);

function project(criteriaHeader = ''): { dir: string; criteria: string } {
  const dir = mkdtempSync(join(tmpdir(), 'vetkit-migrate-'));
  cpSync(runFixture, dir, { recursive: true });
  const criteria = join(dir, 'evals', 'criteria.yaml');
  const body = readFileSync(criteria, 'utf8');
  writeFileSync(criteria, `${criteriaHeader}${body}`);
  return { dir, criteria };
}

function runMigrate(args: readonly string[], cwd: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
  delete env['CEV_LOG_LEVEL'];
  delete env['CI'];
  const result = spawnSync(process.execPath, [binPath, 'migrate', ...args], {
    cwd,
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

function parseJson(text: string): unknown {
  const result = safeParseJson<unknown>(text, {});
  if (!result.ok) throw result.error;
  return result.value;
}

describe('vet migrate', () => {
  it('--check exits 1 and writes nothing when schemaVersion is missing', () => {
    const { dir, criteria } = project();
    const before = readFileSync(criteria, 'utf8');
    const result = runMigrate(['--check'], dir);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('evals/criteria.yaml: schemaVersion missing (current 1)');
    expect(readFileSync(criteria, 'utf8')).toBe(before);
  });

  it('stamps criteria.yaml, keeps comments and exits 0', () => {
    const { dir, criteria } = project('# keep me\n# and me\n');
    const result = runMigrate([], dir);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('migrated 1 file');
    const text = readFileSync(criteria, 'utf8');
    expect(text.startsWith('# keep me\n# and me\n')).toBe(true);
    expect(text.indexOf('schemaVersion: 1')).toBeGreaterThan(-1);
    expect(text.indexOf('schemaVersion: 1')).toBeLessThan(text.indexOf('criteria:'));
  });

  it('is a no-op on an up-to-date project', () => {
    const { dir, criteria } = project();
    expect(runMigrate([], dir).status).toBe(0);
    const stamped = readFileSync(criteria, 'utf8');
    const check = runMigrate(['--check'], dir);
    expect(check.status).toBe(0);
    expect(check.stdout.trim()).toBe('up to date');
    const again = runMigrate([], dir);
    expect(again.status).toBe(0);
    expect(again.stdout.trim()).toBe('up to date');
    expect(readFileSync(criteria, 'utf8')).toBe(stamped);
  });

  it('--json prints the files array and the migrated count', () => {
    const { dir } = project();
    writeFileSync(join(dir, 'criteria.lock.json'), JSON.stringify({ lockVersion: 1 }));
    const result = runMigrate(['--json'], dir);
    expect(result.status).toBe(0);
    expect(parseJson(result.stdout)).toEqual({
      files: [
        {
          path: 'evals/criteria.yaml',
          format: 'criteria',
          from: null,
          to: 1,
          action: 'stamped',
        },
        { path: 'criteria.lock.json', format: 'lock', from: 1, to: 1, action: 'up-to-date' },
      ],
      migrated: 1,
    });
  });

  it('a newer schemaVersion exits 2 with the migrate link', () => {
    const { dir, criteria } = project('schemaVersion: 2\n');
    const before = readFileSync(criteria, 'utf8');
    const result = runMigrate([], dir);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(
      `criteria.yaml schemaVersion 2 is newer than this vetkit supports (1); upgrade vetkit or see ${LINK}`,
    );
    expect(readFileSync(criteria, 'utf8')).toBe(before);

    const json = runMigrate(['--json'], dir);
    expect(json.status).toBe(2);
    expect(json.stdout).not.toContain('"files"');
  });

  it('reports the lock as up-to-date when present', () => {
    const { dir } = project('schemaVersion: 1\n');
    writeFileSync(join(dir, 'criteria.lock.json'), JSON.stringify({ lockVersion: 1 }));
    const result = runMigrate(['--json'], dir);
    expect(result.status).toBe(0);
    const doc = parseJson(result.stdout);
    expect(doc).toMatchObject({
      files: [
        { format: 'criteria', action: 'up-to-date' },
        { format: 'lock', from: 1, to: 1, action: 'up-to-date' },
      ],
      migrated: 0,
    });
    const withoutLock = project('schemaVersion: 1\n');
    const other = parseJson(runMigrate(['--json'], withoutLock.dir).stdout);
    expect(other).toEqual({
      files: [expect.objectContaining({ format: 'criteria', action: 'up-to-date' })],
      migrated: 0,
    });
  });

  it('resolves the project through --config', () => {
    const { dir } = project();
    const result = runMigrate(['--config', join(dir, 'vetkit.config.ts')], tmpdir());
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('migrated 1 file');
  });

  it('is registered with a description', () => {
    const command = createProgram().commands.find((c) => c.name() === 'migrate');
    expect(command).toBeDefined();
    expect(command?.description().length).toBeGreaterThan(0);
    const help = runMigrate(['--help'], tmpdir());
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('--check');
  });
});
