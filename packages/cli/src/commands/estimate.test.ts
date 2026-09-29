import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JEV_PRESETS } from '@vetkit/judge-jev';
import { safeParseJson } from '@vetkit/spec';
import { beforeAll, describe, expect, test } from 'vitest';
import { ensureCliBuilt } from '../test-support/build-cli.js';

const binPath = fileURLToPath(new URL('../../dist/bin.js', import.meta.url));
const fixtureDir = fileURLToPath(new URL('../../../../fixtures/cli/run', import.meta.url));

beforeAll(async () => {
  await ensureCliBuilt();
}, 180_000);

interface Result {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number | null;
  /** True when the child called fetch (the stub records it, then throws). */
  readonly fetched: boolean;
}

// A fresh copy of the fake-judge project (in-process judge, transport 'fake', no price).
function freshProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vetkit-estimate-'));
  cpSync(fixtureDir, dir, { recursive: true });
  return dir;
}

// A project whose judge is a descriptor for the preset that carries a price row, named
// from the adapter's own export (no vendor literal here).
function pricedProject(): { dir: string; pricing: { source: string; asOf: string } } {
  const entry = Object.entries(JEV_PRESETS).find(([, p]) => p.pricing !== undefined);
  const pricing = entry?.[1].pricing;
  if (entry === undefined || pricing === undefined) {
    throw new Error('no JEV_PRESETS entry carries pricing');
  }
  const [preset] = entry;
  const dir = freshProject();
  writeFileSync(
    join(dir, 'vetkit.config.ts'),
    `export default { judge: { kind: 'typesafe-compatible', preset: '${preset}', apiKeyEnv: 'VETKIT_ESTIMATE_KEY' } };\n`,
  );
  return { dir, pricing };
}

// Preload that replaces fetch with a stub that records the call and throws.
function fetchStub(dir: string): { preload: string; marker: string } {
  const marker = join(dir, 'fetch-called');
  const preload = join(dir, 'no-fetch.mjs');
  writeFileSync(
    preload,
    `import { writeFileSync } from 'node:fs';\nglobalThis.fetch = () => { writeFileSync(${JSON.stringify(marker)}, 'x'); throw new Error('fetch is forbidden in vet estimate'); };\n`,
  );
  return { preload, marker };
}

function runVet(args: readonly string[], cwd: string, withKey = true): Result {
  const { preload, marker } = fetchStub(cwd);
  rmSync(marker, { force: true });
  const env: Record<string, string | undefined> = {
    ...process.env,
    NO_COLOR: '1',
    VETKIT_ESTIMATE_KEY: 'dummy-key',
    NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
  };
  if (!withKey) delete env['VETKIT_ESTIMATE_KEY'];
  const result = spawnSync(process.execPath, [binPath, ...args], { cwd, encoding: 'utf8', env });
  return { ...result, fetched: existsSync(marker) };
}

function parseJson(text: string): Record<string, unknown> {
  const result = safeParseJson<Record<string, unknown>>(text, { type: 'object' });
  if (!result.ok) throw result.error;
  return result.value;
}

describe('vet estimate', () => {
  test('--json prints calls, tokens, cost and minutes with no fetch; unpriced cost is unknown', () => {
    const result = runVet(['estimate', '--json'], freshProject());
    expect(result.status).toBe(0);
    expect(result.fetched).toBe(false);
    const doc = parseJson(result.stdout);
    expect(doc).toMatchObject({
      for: 'run',
      cases: 1,
      calls: 1,
      cacheHits: 0,
      cost: 'unknown',
      callsPerMinute: 25,
    });
    expect(doc['inputTokens']).toEqual(expect.any(Number));
    expect(doc['minutes']).toBeCloseTo(1 / 25);
  });

  test('a priced transport gets a USD cost with its source and asOf; still no fetch', () => {
    const { dir, pricing } = pricedProject();
    const result = runVet(['estimate', '--json'], dir);
    expect(result.status).toBe(0);
    expect(result.fetched).toBe(false);
    const doc = parseJson(result.stdout);
    expect(doc['cost']).toEqual({
      usd: expect.any(Number),
      source: pricing.source,
      asOf: pricing.asOf,
    });
  });

  test('runs with the judge key env var unset: no credential is needed and no fetch', () => {
    const { dir } = pricedProject();
    const result = runVet(['estimate', '--json'], dir, false);
    expect(result.stderr).not.toMatch(/VETKIT_ESTIMATE_KEY/);
    expect(result.status).toBe(0);
    expect(result.fetched).toBe(false);
    expect(parseJson(result.stdout)).toMatchObject({ for: 'run', calls: 1 });
  });

  test('human output names the calls, the cache hit count, the minutes and the price asOf', () => {
    const { dir } = pricedProject();
    const result = runVet(['estimate'], dir);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/calls: 1\b/);
    expect(result.stdout).toMatch(/0 cache hits/);
    expect(result.stdout).toMatch(/25 calls\/min/);
    expect(result.stdout).toMatch(/as of \d{4}-\d{2}-\d{2}/);
    expect(result.stdout).toMatch(/\$\d/);
  });

  test('human output says cost unknown for a transport without a price', () => {
    const result = runVet(['estimate'], freshProject());
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/cost: unknown/);
  });

  test('cached cases are subtracted: after vet run the case is a cache hit and 0 calls', () => {
    const dir = freshProject();
    const run = spawnSync(process.execPath, [binPath, 'run', '--json'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
    });
    expect(run.status).toBe(0);
    const result = runVet(['estimate', '--json'], dir);
    expect(result.status).toBe(0);
    expect(parseJson(result.stdout)).toMatchObject({ cacheHits: 1, calls: 0 });
    const human = runVet(['estimate'], dir);
    expect(human.stdout).toMatch(/1 cache hit/);
  });

  test('--for validate reports the gauntlet parts as unknown without guessing', () => {
    const result = runVet(['estimate', '--for', 'validate', '--json'], freshProject());
    expect(result.status).toBe(0);
    expect(result.fetched).toBe(false);
    const doc = parseJson(result.stdout);
    expect(doc['for']).toBe('validate');
    expect(doc['parts']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'gauntlet-bias', calls: 'unknown' }),
        expect.objectContaining({ name: 'gauntlet-controls', calls: 'unknown' }),
      ]),
    );
    const human = runVet(['estimate', '--for', 'validate'], freshProject());
    expect(human.status).toBe(0);
    expect(human.stdout).toMatch(/gauntlet-bias.*unknown/);
  });

  test('--for validate prints numbers for calibration from the exported repeat count', async () => {
    const { CALIBRATION_MIN_REPEATS } = await import('@vetkit/core');
    const result = runVet(['estimate', '--for', 'validate', '--json'], freshProject());
    expect(result.status).toBe(0);
    expect(result.fetched).toBe(false);
    const doc = parseJson(result.stdout);
    expect(doc['parts']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'calibration',
          calls: CALIBRATION_MIN_REPEATS,
          minutes: expect.any(Number),
        }),
      ]),
    );
    const human = runVet(['estimate', '--for', 'validate'], freshProject());
    expect(human.stdout).toMatch(
      new RegExp(`calibration: calls ${String(CALIBRATION_MIN_REPEATS)}\\b`),
    );
  });

  test('zero cases prints nothing to estimate and exits 0', () => {
    const dir = freshProject();
    writeFileSync(join(dir, 'evals', 'cases', 'cases.jsonl'), '');
    const result = runVet(['estimate'], dir);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/nothing to estimate/);
  });

  test('--for with an unknown target is a usage error (exit 2)', () => {
    const result = runVet(['estimate', '--for', 'watch'], freshProject());
    expect(result.status).toBe(2);
  });

  test('a criterion with enabled: false is excluded from the criteria and cost counts', () => {
    const dir = freshProject();
    writeFileSync(
      join(dir, 'evals', 'criteria.yaml'),
      `criteria:
  - id: tone
    type: boolean
    instructions: Is the reply polite?
    escape: The reply has no discernible tone.
    polarity: pass_when_true
    channel: quality
    provenance:
      traceIds: []
  - id: extra
    type: boolean
    instructions: Is the reply extra?
    escape: The reply has no discernible tone.
    polarity: pass_when_true
    channel: quality
    enabled: false
    provenance:
      traceIds: []
`,
    );
    const result = runVet(['estimate', '--json'], dir);
    expect(result.status).toBe(0);
    const doc = parseJson(result.stdout);
    expect(doc['criteria']).toBe(1);
  });
});
