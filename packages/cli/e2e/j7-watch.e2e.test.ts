// J7 journey (bd classified-evals-mol-529): `vet watch` in fixtures/projects/j7 samples 100
// replayed traces, judges the sample with the REAL Jev judge (transport from vetkit.config.ts),
// writes results through the outbox, reports coverage and promotes the injected failing trace.
// Encodes the gate steps in TypeScript (the collector is an in-test OTLP/HTTP stub; the docker
// collector variant is scripts/smoke-j7.sh). Final cold gate only: skipped unless CEV_E2E=1.
// The key comes from AI_GATEWAY_API_KEY, else the repo .env via --env-file (never printed).
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashToUnit } from '@vetkit/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { replay } from '../../../scripts/replay-otlp.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const BIN = join(ROOT, 'packages/cli/dist/bin.js');
const FIXTURE_PROJECT = join(ROOT, 'fixtures/projects/j7');
const TRACE_FIXTURE = join(ROOT, 'fixtures/otlp/gen_ai-latest.json');
const ENV_FILE = process.env['VETKIT_ENV_FILE'] ?? join(ROOT, '.env');
const RATE = 0.1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) throw new Error('expected a JSON object');
  return value;
}

function items(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function portOf(server: { address(): unknown }): number {
  const address = server.address();
  return isRecord(address) && typeof address['port'] === 'number' ? address['port'] : 0;
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createNetServer();
    server.listen(0, '127.0.0.1', () => {
      const port = portOf(server);
      server.close(() => resolve(port));
    });
  });
}

const envArgs = (process.env['AI_GATEWAY_API_KEY'] ?? '') === '' ? [`--env-file=${ENV_FILE}`] : [];

interface WatchRun {
  readonly code: number | null;
  readonly summary: Record<string, unknown>;
  readonly replayed: { traceIds: string[]; injected: string[] };
}

/** Starts `vet watch`, replays 100 traces, sends SIGINT once the replay returns, awaits exit. */
async function watchOnce(
  cwd: string,
  args: readonly string[],
  env: Record<string, string>,
  seed: string,
  inject: number,
): Promise<WatchRun> {
  const port = await freePort();
  const child = spawn(
    'bun',
    [...envArgs, BIN, 'watch', '--sample', String(RATE), ...args, '--json', '--port', String(port)],
    {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
  child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
  const exited = new Promise<number | null>((resolve) => child.on('close', resolve));
  for (let i = 0; i < 120 && !stderr.includes('"listening"'); i += 1) {
    // oxlint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 500));
  }
  expect(stderr, 'vet watch never reported listening').toContain('"listening"');
  const replayed = await replay({
    fixture: TRACE_FIXTURE,
    count: 100,
    port,
    seed,
    inject,
    sampleRate: RATE,
    concurrency: 8,
  });
  expect(replayed.failures).toBe(0);
  child.kill('SIGINT');
  const code = await exited;
  return { code, summary: record(stdout), replayed };
}

function lines(path: string): Record<string, unknown>[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => record(l));
}

function check(cwd: string): { produced: number; acknowledged: number; dead: number } {
  const result = spawnSync('bun', [...envArgs, BIN, 'check', '--outbox', '--json'], {
    cwd,
    encoding: 'utf8',
  });
  const doc = record(result.stdout);
  return {
    produced: Number(doc['produced']),
    acknowledged: Number(doc['acknowledged']),
    dead: Number(doc['dead']),
  };
}

describe.skipIf(process.env['CEV_E2E'] !== '1')('J7: vet watch against the real judge', () => {
  let work = '';
  let project = '';
  let collector: Server;
  let received = 0;
  let collectorUrl = '';

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'vetkit-e2e-j7-'));
    project = join(work, 'project');
    cpSync(FIXTURE_PROJECT, project, { recursive: true });
    collector = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        if (req.url === '/v1/logs') {
          for (const r of items(record(body)['resourceLogs']))
            for (const sc of items(isRecord(r) ? r['scopeLogs'] : undefined))
              received += items(isRecord(sc) ? sc['logRecords'] : undefined).length;
        }
        res.setHeader('content-type', 'application/json');
        res.end('{}');
      });
    });
    await new Promise<void>((r) => collector.listen(0, '127.0.0.1', r));
    collectorUrl = `http://127.0.0.1:${String(portOf(collector))}`;
  });

  afterAll(() => {
    collector.close();
    rmSync(work, { recursive: true, force: true });
  });

  it('AC1 + AC3: 100 replayed traces -> inclusion chain, coverage JSON, promoted failing trace', async () => {
    const run = await watchOnce(
      project,
      ['--sink', 'otel'],
      { J7_COLLECTOR_ENDPOINT: collectorUrl },
      'replay',
      1,
    );
    expect(run.code).toBe(0);

    const inclusion = lines(join(project, '.vet/watch/inclusion.jsonl'));
    expect(inclusion).toHaveLength(100);
    const expectedSampled = run.replayed.traceIds.filter((id) => hashToUnit(id) < RATE).length;
    expect(inclusion.filter((r) => r['sampled'] === true)).toHaveLength(expectedSampled);
    expect(run.summary['seen']).toBe(100);
    expect(run.summary['sampled']).toBe(expectedSampled);
    expect(run.summary['judged']).toBe(expectedSampled);

    const today = new Date().toISOString().slice(0, 10);
    const promoted = lines(join(project, `evals/cases/pending/promoted-${today}.jsonl`));
    const promotedIds = promoted.map((c) => {
      const provenance = c['provenance'];
      const from = isRecord(provenance) ? provenance['promotedFrom'] : undefined;
      return isRecord(from) ? from['traceId'] : undefined;
    });
    expect(promotedIds).toContain(run.replayed.injected[0]);

    const outbox = check(project);
    expect(outbox.produced).toBe(outbox.acknowledged);
    expect(outbox.produced).toBeGreaterThan(0);
    expect(received).toBe(outbox.acknowledged);
  });

  it('AC2: after a forced 3-item rejection the outbox ends with produced == acknowledged', async () => {
    rmSync(join(project, '.vet'), { recursive: true, force: true });
    rmSync(join(project, 'evals/cases/pending'), { recursive: true, force: true });
    const log = join(work, 'flaky.log');
    const run = await watchOnce(
      project,
      ['--sink', 'flaky'],
      { VETKIT_FIXTURE_REJECT: '3', VETKIT_FIXTURE_SINK_LOG: log },
      'b',
      0,
    );
    expect(run.code).toBe(0);
    expect(existsSync(log)).toBe(true);
    const rejected = lines(log).reduce((sum, l) => sum + Number(l['rejected']), 0);
    expect(rejected).toBe(3);
    const outbox = check(project);
    expect(outbox.produced).toBe(outbox.acknowledged);
    expect(outbox.produced).toBeGreaterThan(0);
  });
});
