import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeParseJson } from '@vetkit/spec';
import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { ensureCliBuilt } from '../test-support/build-cli.js';
import { renderSummary } from './watch.ts';

const binPath = fileURLToPath(new URL('../../dist/bin.js', import.meta.url));
const fixtureDir = fileURLToPath(new URL('../../../../fixtures/cli/watch', import.meta.url));

// vitest.setup.ts replaces global fetch with a network-blocking guard by default (unit tests
// never make live calls); this suite posts real loopback HTTP to the CLI's own child-process
// receiver, so it restores the platform fetch captured at import time (same pattern as
// packages/source-otlp/src/receiver/receiver.test.ts).
const realFetch = globalThis.fetch;
beforeEach(() => {
  vi.stubGlobal('fetch', realFetch);
});

beforeAll(async () => {
  await ensureCliBuilt();
}, 180_000);

interface Result {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number | null;
}

function freshProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vetkit-watch-'));
  cpSync(fixtureDir, dir, { recursive: true });
  return dir;
}

function fixtureEnv(mode: string): NodeJS.ProcessEnv {
  return { ...process.env, NO_COLOR: '1', VETKIT_FIXTURE_MODE: mode };
}

function runVet(args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Result {
  return spawnSync(process.execPath, [binPath, ...args], { cwd, env, encoding: 'utf8' });
}

function parseJson(text: string): unknown {
  const result = safeParseJson<unknown>(text, {});
  if (!result.ok) throw result.error;
  return result.value;
}

function nonEmptyLines(text: string): string[] {
  return text.split('\n').filter((line) => line.trim() !== '');
}

async function waitUntil(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
}

function listeningPort(stderr: string): number | undefined {
  const match = /"listening":\{"port":(\d+)\}/.exec(stderr);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

function otlpTraceBody(traceId: string, userText: string, assistantText: string): string {
  return JSON.stringify({
    resourceSpans: [
      {
        resource: { attributes: [] },
        scopeSpans: [
          {
            spans: [
              {
                traceId,
                spanId: '0102030405060708',
                name: 'chat-turn-1',
                kind: 1,
                startTimeUnixNano: '1700000000000000000',
                endTimeUnixNano: '1700000001000000000',
                attributes: [
                  { key: 'gen_ai.operation.name', value: { stringValue: 'chat' } },
                  {
                    key: 'gen_ai.input.messages',
                    value: {
                      stringValue: JSON.stringify([
                        { role: 'user', parts: [{ type: 'text', content: userText }] },
                      ]),
                    },
                  },
                  {
                    key: 'gen_ai.output.messages',
                    value: {
                      stringValue: JSON.stringify([
                        { role: 'assistant', parts: [{ type: 'text', content: assistantText }] },
                      ]),
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  });
}

async function postTrace(port: number, traceId: string): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${String(port)}/v1/traces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: otlpTraceBody(traceId, 'hi there', 'sure, here you go'),
  });
  if (!res.ok) throw new Error(`postTrace failed: ${String(res.status)}`);
}

// patches a freshProject() copy's vetkit.config.ts (the checked-in fixture stays
// untouched) to add a `sinks: [{kind:'otel',endpoint}]` descriptor, so `--sink otel` resolves
// to a real @vetkit/sink-otel adapter pointed at this test's own fake collector.
function withOtelSink(project: string, endpoint: string): void {
  const configPath = join(project, 'vetkit.config.ts');
  const text = readFileSync(configPath, 'utf8');
  const marker = 'export default { judge };';
  if (!text.includes(marker)) {
    throw new Error(`fixture vetkit.config.ts no longer ends with ${marker}; update withOtelSink`);
  }
  const patched = text.replace(
    marker,
    `export default { judge, sinks: [{ kind: 'otel' as const, endpoint: ${JSON.stringify(endpoint)} }] };`,
  );
  writeFileSync(configPath, patched);
}

interface FakeCollector {
  readonly url: string;
  close(): Promise<void>;
}

// A minimal OTLP/HTTP logs collector: accepts any request body and answers 200 with an empty
// body (createOtelSink's rejectedCount treats that as zero rejections — every entry accepted).
function fakeOtelCollector(): Promise<FakeCollector> {
  const server = createHttpServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end();
    });
  });
  return new Promise((resolvePromise) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolvePromise({
        url: `http://127.0.0.1:${String(port)}/v1/logs`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function outboxPendingPath(project: string): string {
  return join(project, '.vet', 'outbox', 'pending.jsonl');
}

function pendingCasesDir(project: string): string {
  return join(project, 'evals', 'cases', 'pending');
}

interface SpawnedWatch {
  readonly project: string;
  readonly exited: Promise<number | null>;
  getStdout(): string;
  getStderr(): string;
  kill(): void;
  waitForPort(): Promise<number>;
  waitForJudged(): Promise<void>;
}

function spawnWatch(args: readonly string[], mode: string, project = freshProject()): SpawnedWatch {
  const child = spawn(process.execPath, [binPath, 'watch', ...args], {
    cwd: project,
    env: fixtureEnv(mode),
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  const exited = new Promise<number | null>((resolvePromise) => {
    child.on('exit', (code) => resolvePromise(code));
  });
  return {
    project,
    exited,
    getStdout: () => stdout,
    getStderr: () => stderr,
    kill: () => child.kill('SIGINT'),
    async waitForPort() {
      await waitUntil(() => listeningPort(stderr) !== undefined);
      const port = listeningPort(stderr);
      if (port === undefined) throw new Error('unreachable: waitUntil guarantees a port');
      return port;
    },
    async waitForJudged() {
      const path = outboxPendingPath(project);
      await waitUntil(() => existsSync(path) && readFileSync(path, 'utf8').trim() !== '');
    },
  };
}

describe('vet watch', () => {
  test('summary JSON on SIGINT: exit 0, judges the sampled trace, and promotes the failure', async () => {
    const w = spawnWatch(['--sample', '1', '--port', '0', '--json'], 'fail');
    const port = await w.waitForPort();
    await postTrace(port, '11112222333344445555666677778888');
    await w.waitForJudged();
    w.kill();
    const code = await w.exited;

    expect(code).toBe(0);
    const doc = parseJson(w.getStdout());
    expect(doc).toMatchObject({ seen: 1, sampled: 1, judged: 1, promoted: 1, promotedSkipped: 0 });
    expect(nonEmptyLines(w.getStdout())).toHaveLength(1);
    // Progress (the receiver's listening line) is on stderr only, never stdout.
    expect(w.getStdout()).not.toContain('listening');
    expect(w.getStderr()).toContain('listening');

    const files = readdirSync(pendingCasesDir(w.project));
    expect(files).toHaveLength(1);
    const line = readFileSync(join(pendingCasesDir(w.project), files[0] ?? ''), 'utf8').trim();
    const promotedCase = parseJson(line);
    expect(promotedCase).toMatchObject({
      provenance: {
        promotedFrom: { traceId: '11112222333344445555666677778888', criterionId: 'tone' },
      },
    });
  }, 20_000);

  test('--no-promote never writes evals/cases/pending/', async () => {
    const w = spawnWatch(['--sample', '1', '--port', '0', '--json', '--no-promote'], 'fail');
    const port = await w.waitForPort();
    await postTrace(port, '22223333444455556666777788889999');
    await w.waitForJudged();
    w.kill();
    const code = await w.exited;

    expect(code).toBe(0);
    const doc = parseJson(w.getStdout());
    expect(doc).toMatchObject({ seen: 1, sampled: 1, judged: 1, promoted: 0, promotedSkipped: 0 });
    expect(existsSync(pendingCasesDir(w.project))).toBe(false);
  }, 20_000);

  test('a receiver bind failure exits 2 with RECEIVER_BIND, naming the port', async () => {
    const server = createServer();
    await new Promise<void>((resolvePromise) => {
      server.listen(0, '127.0.0.1', resolvePromise);
    });
    const address = server.address();
    const busyPort = typeof address === 'object' && address !== null ? address.port : 0;

    const result = runVet(
      ['watch', '--sample', '0.5', '--port', String(busyPort)],
      freshProject(),
      fixtureEnv('pass'),
    );
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('RECEIVER_BIND');
    expect(result.stderr).toContain(String(busyPort));
  });

  test('--sample out of range exits 2 with WATCH_CONFIG', () => {
    const result = runVet(
      ['watch', '--sample', '2', '--port', '0'],
      freshProject(),
      fixtureEnv('pass'),
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('WATCH_CONFIG');
  });

  // bug: judgeFn never set verdict.provenance, so an otel sink (which dead-letters any
  // verdict with no correlation id) rejected every enqueued verdict. Reproduces the cold-gate
  // repro (fixtures/cli/watch + a real otel sink) with a fake collector standing in for the
  // real OTLP endpoint.
  test('every verdict watch enqueues carries provenance: an otel sink acknowledges it, produced == acknowledged', async () => {
    const collector = await fakeOtelCollector();
    try {
      const project = freshProject();
      withOtelSink(project, collector.url);
      const w = spawnWatch(
        ['--sample', '1', '--port', '0', '--json', '--sink', 'otel'],
        'fail',
        project,
      );
      const port = await w.waitForPort();
      await postTrace(port, 'aaaa1111bbbb2222cccc3333dddd4444');
      await w.waitForJudged();
      w.kill();
      const code = await w.exited;

      expect(code).toBe(0);
      expect(parseJson(w.getStdout())).toMatchObject({ judged: 1 });
      const summary = safeParseJson<{ produced: number; acknowledged: number }>(w.getStdout(), {
        type: 'object',
        properties: { produced: { type: 'number' }, acknowledged: { type: 'number' } },
      });
      expect(summary.ok).toBe(true);
      if (!summary.ok) return;
      expect(summary.value.produced).toBeGreaterThan(0);
      expect(summary.value.acknowledged).toBe(summary.value.produced);

      const checked = runVet(['check', '--outbox', '--json'], project, fixtureEnv('fail'));
      expect(checked.status).toBe(0);
      expect(parseJson(checked.stdout)).toMatchObject({
        produced: summary.value.produced,
        acknowledged: summary.value.produced,
        dead: 0,
      });
    } finally {
      await collector.close();
    }
  }, 20_000);

  test('SIGINT right after a burst: every accepted trace is recorded (seen == posted) and the outbox is drained', async () => {
    const collector = await fakeOtelCollector();
    try {
      const project = freshProject();
      withOtelSink(project, collector.url);
      const w = spawnWatch(
        ['--sample', '1', '--port', '0', '--json', '--sink', 'otel'],
        'pass',
        project,
      );
      const port = await w.waitForPort();
      const posted = 40;
      await Promise.all(
        Array.from({ length: posted }, (_, i) =>
          postTrace(port, `${String(i).padStart(4, '0')}${'ab'.repeat(14)}`),
        ),
      );
      w.kill();
      const code = await Promise.race([
        w.exited,
        new Promise<string>((r) => setTimeout(() => r('hung'), 15_000)),
      ]);

      expect(code).toBe(0);
      const parsed = safeParseJson<{
        seen: number;
        judged: number;
        produced: number;
        acknowledged: number;
      }>(w.getStdout(), {
        type: 'object',
        properties: {
          seen: { type: 'number' },
          judged: { type: 'number' },
          produced: { type: 'number' },
          acknowledged: { type: 'number' },
        },
      });
      if (!parsed.ok) throw parsed.error;
      const summary = parsed.value;
      expect(summary.seen).toBe(posted);
      expect(summary.judged).toBe(posted);
      expect(summary.acknowledged).toBe(summary.produced);
    } finally {
      await collector.close();
    }
  }, 30_000);
});

describe('watch summary text', () => {
  const base = {
    seen: 20,
    sampled: 12,
    judged: 9,
    promoted: 0,
    produced: 9,
    acknowledged: 9,
    excluded: { content_not_captured: 0, truncated: 0, incomplete_trace: 0 },
  } as const;

  test('names the outage with cause code and count when unscored > 0', () => {
    const text = renderSummary({ ...base, unscored: 3, unscoredCauses: ['JUDGE_THROTTLED'] }, 0);
    expect(text).toContain('judged 9');
    expect(text).toContain('unscored 3');
    expect(text).toContain('JUDGE_THROTTLED x 3');
  });

  test('says nothing about an outage when unscored is 0', () => {
    const text = renderSummary({ ...base, judged: 12, unscored: 0, unscoredCauses: [] }, 0);
    expect(text).not.toMatch(/unscored|JUDGE_/);
  });
});
