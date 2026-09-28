import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeParseJson } from '@vetkit/spec';
import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { ensureCliBuilt } from '../test-support/build-cli.js';

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

function spawnWatch(args: readonly string[], mode: string): SpawnedWatch {
  const project = freshProject();
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
});
