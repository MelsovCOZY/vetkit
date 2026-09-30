import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeParseJson } from '@vetkit/spec';
import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { ensureCliBuilt } from '../test-support/build-cli.js';

const binPath = fileURLToPath(new URL('../../dist/bin.js', import.meta.url));
const fixtureDir = fileURLToPath(new URL('../../../../fixtures/cli/watch', import.meta.url));

// Same as watch.test.ts: unit tests block global fetch by default; this suite posts real
// loopback HTTP to the CLI's own child-process receiver.
const realFetch = globalThis.fetch;
beforeEach(() => {
  vi.stubGlobal('fetch', realFetch);
});

beforeAll(async () => {
  await ensureCliBuilt();
}, 180_000);

const MESSAGE = 'fake judge says: bad credentials xyzzy';

// A copy of the checked-in watch fixture whose in-process judge throws a VetError-shaped error
// (the Symbol.for marker is how VetError.isInstance recognises errors across module copies).
function projectWithFailingJudge(code: string, kind: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'vetkit-watch-terminal-'));
  cpSync(fixtureDir, dir, { recursive: true });
  const configPath = join(dir, 'vetkit.config.ts');
  const text = readFileSync(configPath, 'utf8');
  const marker = 'async doJudge(req: { questions: Record<string, unknown> }) {';
  if (!text.includes(marker)) throw new Error('fixture vetkit.config.ts changed; update marker');
  const thrower = `${marker}
    const err = Object.assign(new Error(${JSON.stringify(MESSAGE)}), {
      name: 'VetError',
      code: ${JSON.stringify(code)},
      details: { kind: ${JSON.stringify(kind)}, retryable: ${JSON.stringify(kind === 'retryable')} },
    });
    (err as unknown as Record<symbol, unknown>)[Symbol.for('vetkit.error')] = true;
    throw err;`;
  writeFileSync(configPath, text.replace(marker, thrower));
  return dir;
}

async function waitUntil(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
}

function otlpTraceBody(traceId: string): string {
  const msg = (role: string, content: string): string =>
    JSON.stringify([{ role, parts: [{ type: 'text', content }] }]);
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
                  { key: 'gen_ai.input.messages', value: { stringValue: msg('user', 'hi') } },
                  { key: 'gen_ai.output.messages', value: { stringValue: msg('assistant', 'yo') } },
                ],
              },
            ],
          },
        ],
      },
    ],
  });
}

interface Watch {
  readonly project: string;
  readonly exited: Promise<number | null>;
  stderr(): string;
  stdout(): string;
  kill(): void;
}

function spawnWatch(project: string): Watch {
  const child = spawn(
    process.execPath,
    [binPath, 'watch', '--sample', '1', '--port', '0', '--json'],
    {
      cwd: project,
      env: { ...process.env, NO_COLOR: '1' },
    },
  );
  let stderr = '';
  let stdout = '';
  child.stderr.setEncoding('utf8').on('data', (c: string) => (stderr += c));
  child.stdout.setEncoding('utf8').on('data', (c: string) => (stdout += c));
  const exited = new Promise<number | null>((resolvePromise) => {
    child.on('exit', (code) => resolvePromise(code));
  });
  return {
    project,
    exited,
    stderr: () => stderr,
    stdout: () => stdout,
    kill: () => child.kill('SIGINT'),
  };
}

async function portOf(w: Watch): Promise<number> {
  await waitUntil(() => /"listening":\{"port":(\d+)\}/.test(w.stderr()));
  return Number(/"listening":\{"port":(\d+)\}/.exec(w.stderr())?.[1]);
}

async function post(port: number, traceId: string): Promise<void> {
  try {
    await fetch(`http://127.0.0.1:${String(port)}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: otlpTraceBody(traceId),
    });
  } catch {
    // The receiver may already be closed by a terminal stop; that is the behaviour under test.
  }
}

describe('vet watch judge errors', () => {
  test('terminal judge error stops watch with exit 2', async () => {
    const cases = [
      ['terminal-auth', 'JUDGE_UNAUTHORIZED'],
      ['terminal-billing', 'JUDGE_UNAVAILABLE'],
      ['terminal-request', 'JUDGE_BAD_RESPONSE'],
    ] as const;
    for (const [kind, code] of cases) {
      const w = spawnWatch(projectWithFailingJudge(code, kind));
      const port = await portOf(w);
      await post(port, '11112222333344445555666677778888');
      const exit = await Promise.race([
        w.exited,
        new Promise<'hang'>((r) => setTimeout(() => r('hang'), 8000)),
      ]);
      if (exit === 'hang') w.kill();

      expect([kind, exit]).toEqual([kind, 2]);
      expect(w.stderr().split(MESSAGE).length - 1).toBe(1);
      expect(w.stderr()).not.toContain('UnhandledPromiseRejection');
      // Nothing further reached the outbox as a judged/unscored verdict.
      const pending = join(w.project, '.vet', 'outbox', 'pending.jsonl');
      expect(existsSync(pending) ? readFileSync(pending, 'utf8').trim() : '').toBe('');
    }
  }, 60_000);

  test('retryable judge error keeps watching', async () => {
    const w = spawnWatch(projectWithFailingJudge('JUDGE_UNAVAILABLE', 'retryable'));
    const port = await portOf(w);
    await post(port, '22223333444455556666777788889999');
    const pending = join(w.project, '.vet', 'outbox', 'pending.jsonl');
    await waitUntil(() => existsSync(pending) && readFileSync(pending, 'utf8').trim() !== '');
    // Still running: no exit yet, then SIGINT drains and exits 0 with the trace unscored.
    w.kill();
    expect(await w.exited).toBe(0);
    const doc = safeParseJson<Record<string, unknown>>(w.stdout(), {});
    expect(doc.ok && doc.value).toMatchObject({ seen: 1, sampled: 1, judged: 0, unscored: 1 });
  }, 30_000);
});
