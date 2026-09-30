import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeParseJson } from '@vetkit/spec';
import { beforeAll, describe, expect, test } from 'vitest';
import { ensureCliBuilt } from '../test-support/build-cli.js';

const binPath = fileURLToPath(new URL('../../dist/bin.js', import.meta.url));
const fixtureDir = fileURLToPath(new URL('../../../../fixtures/cli/run', import.meta.url));
const ENTRY_RE = /^[0-9a-f]{64}\.json$/;

beforeAll(async () => {
  await ensureCliBuilt();
}, 180_000);

interface Result {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number | null;
}

// A private copy of the fixture project per test (pattern: run.test.ts).
function freshProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vetkit-cache-'));
  cpSync(fixtureDir, dir, { recursive: true });
  return dir;
}

function runVet(args: readonly string[], cwd: string): Result {
  return spawnSync(process.execPath, [binPath, ...args], {
    cwd,
    env: { ...process.env, NO_COLOR: '1', VETKIT_FIXTURE_MODE: 'pass' },
    encoding: 'utf8',
  });
}

function parseJson(text: string): unknown {
  const result = safeParseJson<unknown>(text, {});
  if (!result.ok) throw result.error;
  return result.value;
}

function entries(project: string): string[] {
  const dir = join(project, '.vet');
  return existsSync(dir) ? readdirSync(dir).filter((n) => ENTRY_RE.test(n)) : [];
}

function onlyEntry(project: string): string {
  const [name, ...rest] = entries(project);
  expect(name).toBeDefined();
  expect(rest).toHaveLength(0);
  return join(project, '.vet', name ?? '');
}

describe('vet run cache visibility and vet cache clear', () => {
  test("first run prints 'cache: 0 cached, 1 judged'; second run prints 'cache: 1 cached, 0 judged'", () => {
    const project = freshProject();
    const first = runVet(['run'], project);
    expect(first.status).toBe(0);
    expect(first.stdout).toContain('cache: 0 cached, 1 judged');
    const second = runVet(['run'], project);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain('cache: 1 cached, 0 judged');
  });

  test("--no-cache prints 'cache: 0 cached, 1 judged' on a warm cache and leaves the entry's mtime unchanged", async () => {
    const project = freshProject();
    expect(runVet(['run'], project).status).toBe(0);
    const entry = onlyEntry(project);
    const before = statSync(entry).mtimeMs;
    await new Promise((r) => setTimeout(r, 30));
    const result = runVet(['run', '--no-cache'], project);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('cache: 0 cached, 1 judged');
    expect(statSync(entry).mtimeMs).toBe(before);
  });

  test('--no-cache on a cold cache writes no <64hex>.json', () => {
    const project = freshProject();
    const result = runVet(['run', '--no-cache'], project);
    expect(result.status).toBe(0);
    expect(entries(project)).toHaveLength(0);
  });

  test('a corrupt entry is reported once on stderr with [CACHE_CORRUPT] and re-judged (cacheHit false), and the entry is valid JSON afterwards', () => {
    const project = freshProject();
    expect(runVet(['run'], project).status).toBe(0);
    const entry = onlyEntry(project);
    writeFileSync(entry, '{');
    const result = runVet(['run', '--json'], project);
    expect(result.status).toBe(0);
    const corrupt = result.stderr.split('\n').filter((l) => l.includes('[CACHE_CORRUPT]'));
    expect(corrupt).toHaveLength(1);
    expect(parseJson(result.stdout)).toMatchObject({ results: [{ cacheHit: false }] });
    expect(() => parseJson(readFileSync(entry, 'utf8'))).not.toThrow();
  });

  test('cache clear --json prints {cleared, dir} and leaves runs/latest.json in place', () => {
    const project = freshProject();
    expect(runVet(['run'], project).status).toBe(0);
    expect(existsSync(join(project, '.vet', 'runs', 'latest.json'))).toBe(true);
    const result = runVet(['cache', 'clear', '--json'], project);
    expect(result.status).toBe(0);
    const doc = parseJson(result.stdout);
    expect(doc).toMatchObject({ cleared: 1, dir: expect.stringContaining('.vet') });
    expect(entries(project)).toHaveLength(0);
    expect(existsSync(join(project, '.vet', 'runs', 'latest.json'))).toBe(true);
  });

  test('cache clear on a missing cache dir exits 0 with cleared 0', () => {
    const project = freshProject();
    const result = runVet(['cache', 'clear', '--json'], project);
    expect(result.status).toBe(0);
    expect(parseJson(result.stdout)).toMatchObject({ cleared: 0 });
  });

  test('cache clear --config <path> targets the cache next to that config', () => {
    const project = freshProject();
    expect(runVet(['run'], project).status).toBe(0);
    const elsewhere = mkdtempSync(join(tmpdir(), 'vetkit-cache-cwd-'));
    mkdirSync(join(elsewhere, 'x'));
    const result = runVet(
      ['cache', 'clear', '--json', '--config', join(project, 'vetkit.config.ts')],
      elsewhere,
    );
    expect(result.status).toBe(0);
    expect(parseJson(result.stdout)).toMatchObject({ cleared: 1 });
    expect(entries(project)).toHaveLength(0);
  });

  test('--json output is unchanged: no cache line on stdout, per-verdict cacheHit still present', () => {
    const project = freshProject();
    runVet(['run', '--json'], project);
    const result = runVet(['run', '--json'], project);
    expect(result.stdout).not.toContain('cache:');
    expect(result.stdout.split('\n').filter((l) => l.trim() !== '')).toHaveLength(1);
    expect(parseJson(result.stdout)).toMatchObject({ results: [{ cacheHit: true }] });
  });
});
