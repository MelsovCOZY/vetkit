// Unit + one child-process test for `vet init --source otlp:...` wiring. Every receiver test binds an ephemeral port (0) or a freshly-freed one; none
// ever binds 4318. otlpSourceFromArg is exercised directly here — no full `generateEvals` run —
// except the SIGINT test, which spawns the built bin (test-support/build-cli.ts), following
// run.test.ts's precedent.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GenerateEvalsResult } from '@vetkit/core';
import { safeParseJson, type Case, type NormalizedTrace } from '@vetkit/spec';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { ensureCliBuilt } from '../test-support/build-cli.js';
import { buildOtlpSummary, otlpSourceFromArg } from './init-otlp.ts';

const binPath = fileURLToPath(new URL('../../dist/bin.js', import.meta.url));
const fixtureDir = fileURLToPath(new URL('../../../../fixtures/cli/init/', import.meta.url));
const otlpFixture = fileURLToPath(
  new URL('../../../../fixtures/otlp/gen_ai-latest.json', import.meta.url),
);
const incompleteFixture = fileURLToPath(
  new URL('../../../../fixtures/otlp/incomplete.json', import.meta.url),
);
const goldenInitCases = fileURLToPath(
  new URL('../../../../fixtures/otlp/golden/init-cases.jsonl', import.meta.url),
);
const dialectFixtures = [
  'gen_ai-latest',
  'gen_ai-legacy',
  'openinference',
  'openllmetry',
  'vercel',
] as const;

// vitest.setup.ts replaces global fetch with a network-blocking guard by default; these tests
// POST real loopback HTTP to an in-process receiver on an ephemeral port, so every test here
// restores the platform fetch captured at import time, before the guard ever ran.
const realFetch = globalThis.fetch;
beforeEach(() => {
  vi.stubGlobal('fetch', realFetch);
});

beforeAll(async () => {
  await ensureCliBuilt();
}, 180_000);

function validTraceBody(traceId = '0102030405060708090a0b0c0d0e0f10'): string {
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
                name: 'root',
                kind: 1,
                startTimeUnixNano: '1700000000000000000',
                endTimeUnixNano: '1700000001000000000',
                attributes: [],
              },
            ],
          },
        ],
      },
    ],
  });
}

async function postTrace(port: number, traceId?: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${String(port)}/v1/traces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: validTraceBody(traceId),
  });
}

// A free port is picked by binding an ephemeral one and closing it immediately; a real
// filesystem-path-free port number is needed up front to build the `otlp::<port>` spec string.
function freePort(): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    const probe: Server = createServer();
    probe.once('error', rejectPromise);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolvePromise(port));
    });
  });
}

function watchStderr(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    lines.push(chunk.toString());
    return true;
  });
  return { lines, restore: () => spy.mockRestore() };
}

async function waitForListeningPort(lines: string[]): Promise<number> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    for (const line of lines) {
      const match = /"listening":\{"port":(\d+)\}/.exec(line);
      if (match?.[1] !== undefined) return Number(match[1]);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('receiver never reported a listening port');
}

function tmpOtlpDir(): string {
  return mkdtempSync(join(tmpdir(), 'vetkit-otlp-'));
}

describe('otlpSourceFromArg: file-backed', () => {
  test('otlp:<file> resolves to a file-backed SourceV1', async () => {
    const dir = tmpOtlpDir();
    const file = join(dir, 'a.json');
    writeFileSync(file, validTraceBody('0102030405060708090a0b0c0d0e0f10'));
    const source = otlpSourceFromArg(file);
    expect(source.id).toBe('otlp/file');
    const traces: NormalizedTrace[] = [];
    for await (const trace of source.doRead({})) traces.push(trace);
    expect(traces).toHaveLength(1);
  });

  test('otlp:<dir> resolves to a file-backed SourceV1 over every file in the dir', async () => {
    const dir = tmpOtlpDir();
    writeFileSync(join(dir, 'a.json'), validTraceBody('0102030405060708090a0b0c0d0e0f10'));
    writeFileSync(join(dir, 'b.json'), validTraceBody('101112131415161718191a1b1c1d1e1f'));
    const source = otlpSourceFromArg(dir);
    expect(source.id).toBe('otlp/file');
    const traces: NormalizedTrace[] = [];
    for await (const trace of source.doRead({})) traces.push(trace);
    expect(traces).toHaveLength(2);
  });

  test('a missing --source otlp: path throws SOURCE_UNREADABLE', () => {
    expect(() => otlpSourceFromArg('/does/not/exist/otlp-source')).toThrowError(
      expect.objectContaining({ code: 'SOURCE_UNREADABLE' }),
    );
  });
});

const str = (stringValue: string) => ({ stringValue });

function narratorTraceBody(): string {
  return JSON.stringify({
    resourceSpans: [
      {
        resource: { attributes: [] },
        scopeSpans: [
          {
            spans: [
              {
                traceId: '0102030405060708090a0b0c0d0e0f10',
                spanId: '1112131415161718',
                name: 'chat',
                kind: 1,
                startTimeUnixNano: '1700000000000000000',
                endTimeUnixNano: '1700000001000000000',
                attributes: [
                  { key: 'ai.operationId', value: str('ai.generateText.doGenerate') },
                  {
                    key: 'ai.prompt.messages',
                    value: str(JSON.stringify([{ role: 'narrator', content: 'secret text' }])),
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

async function readWithStderrCaptured(file: string): Promise<string[]> {
  const written: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    written.push(String(chunk));
    return true;
  });
  try {
    for await (const trace of otlpSourceFromArg(file).doRead({})) void trace;
  } finally {
    spy.mockRestore();
  }
  return written;
}

describe('otlpSourceFromArg: source diagnostics under CEV_DIAG', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test('CEV_DIAG=1 writes an unknown_role diag as one JSON line on stderr', async () => {
    vi.stubEnv('CEV_DIAG', '1');
    const file = join(tmpOtlpDir(), 'a.json');
    writeFileSync(file, narratorTraceBody());
    const lines = (await readWithStderrCaptured(file)).filter((l) => l.includes('unknown_role'));
    expect(lines).toHaveLength(1);
    expect(lines[0]?.endsWith('\n')).toBe(true);
    const parsed = safeParseJson<{ diag: { otlp: { detail: string } } }>(lines[0] ?? '', {});
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.diag.otlp).toMatchObject({ code: 'unknown_role', level: 'warn' });
    expect(parsed.value.diag.otlp.detail).toContain('narrator');
    expect(lines[0]).not.toContain('secret text');
  });

  test('without CEV_DIAG nothing is written', async () => {
    vi.stubEnv('CEV_DIAG', '');
    vi.stubEnv('CEV_TRACE_HTTP', '');
    const file = join(tmpOtlpDir(), 'a.json');
    writeFileSync(file, narratorTraceBody());
    const lines = (await readWithStderrCaptured(file)).filter((l) => l.includes('unknown_role'));
    expect(lines).toEqual([]);
  });
});

describe('otlpSourceFromArg: remote form rejected', () => {
  test('otlp:http://host:port is rejected', () => {
    expect(() => otlpSourceFromArg('http://localhost:4318')).toThrowError(
      expect.objectContaining({ code: 'CONFIG_INVALID' }),
    );
  });
});

describe('otlpSourceFromArg: receiver', () => {
  test('otlp::<port> parses to the receiver variant on that port', async () => {
    const port = await freePort();
    const { lines, restore } = watchStderr();
    const controller = new AbortController();
    const source = otlpSourceFromArg(`:${String(port)}`);
    expect(source.id).toBe('otlp/receiver');
    const drained = (async () => {
      const traces: NormalizedTrace[] = [];
      for await (const trace of source.doRead({ signal: controller.signal })) traces.push(trace);
      return traces;
    })();
    const reportedPort = await waitForListeningPort(lines);
    restore();
    expect(reportedPort).toBe(port);
    controller.abort();
    await drained;
  }, 10_000);

  test('otlp::0 parses to an ephemeral port', async () => {
    const { lines, restore } = watchStderr();
    const controller = new AbortController();
    const source = otlpSourceFromArg(':0');
    const drained = (async () => {
      const traces: NormalizedTrace[] = [];
      for await (const trace of source.doRead({ signal: controller.signal })) traces.push(trace);
      return traces;
    })();
    const reportedPort = await waitForListeningPort(lines);
    restore();
    expect(reportedPort).toBeGreaterThan(0);
    controller.abort();
    await drained;
  }, 10_000);

  test('--until N stops the receiver after N traces', async () => {
    const { lines, restore } = watchStderr();
    const source = otlpSourceFromArg(':0', { until: 2 });
    const iterator = source.doRead({})[Symbol.asyncIterator]();
    // An async generator's body only starts running on its first `.next()` call; kick it off
    // (without awaiting yet, since nothing has been posted) before watching stderr for the
    // port it reports once startReceiver resolves.
    const firstPromise = iterator.next();
    const port = await waitForListeningPort(lines);
    restore();
    await postTrace(port, '0102030405060708090a0b0c0d0e0f10');
    await postTrace(port, '101112131415161718191a1b1c1d1e1f');
    const first = await firstPromise;
    const second = await iterator.next();
    const third = await iterator.next();
    expect(first.done).toBe(false);
    expect(second.done).toBe(false);
    expect(third.done).toBe(true);
  }, 10_000);

  test('--seconds S stops the receiver after S seconds', async () => {
    const { restore } = watchStderr();
    const started = Date.now();
    const source = otlpSourceFromArg(':0', { seconds: 0.2 });
    const traces: NormalizedTrace[] = [];
    for await (const trace of source.doRead({})) traces.push(trace);
    restore();
    expect(traces).toHaveLength(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
  }, 10_000);

  // Cross-request traceId dedupe lives here, not in the receiver.
  test('a duplicate traceId across two POSTs yields one trace from doRead', async () => {
    const { lines, restore } = watchStderr();
    const controller = new AbortController();
    const source = otlpSourceFromArg(':0');
    const seen: NormalizedTrace[] = [];
    const drained = (async () => {
      for await (const trace of source.doRead({ signal: controller.signal })) seen.push(trace);
    })();
    const port = await waitForListeningPort(lines);
    restore();
    const traceId = '0102030405060708090a0b0c0d0e0f10';
    await postTrace(port, traceId);
    await postTrace(port, traceId);
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    await drained;
    expect(seen).toHaveLength(1);
  }, 10_000);
});

function fakeCase(id: string): Case {
  return {
    id,
    input: { state: 'user: hi' },
    traceId: id,
    provenance: { traceIds: [id] },
    tags: [],
  };
}

describe('buildOtlpSummary', () => {
  test('summary JSON includes cases, excluded, dialects and tokens', () => {
    const completeness = { contentCaptured: true, truncated: false, missingParents: false };
    const traces: NormalizedTrace[] = [
      {
        traceId: 't1',
        spans: [],
        messages: [],
        dialect: 'gen_ai',
        dialectVersion: 'x',
        completeness,
        tokens: { total: 10 },
      },
      {
        traceId: 't2',
        spans: [],
        messages: [],
        dialect: 'vercel',
        dialectVersion: 'x',
        completeness,
        tokens: { total: 5 },
      },
    ];
    const result: GenerateEvalsResult = {
      criteria: [],
      cases: [fakeCase('t1'), fakeCase('t2')],
      report: {
        status: 'ok',
        issues: [],
        failureModes: [],
        rejected: [],
        warnings: [],
        duplicates: [],
        traces: [
          { traceId: 't1', status: 'ok' },
          { traceId: 't2', status: 'ok' },
          { traceId: 't3', status: 'not_applicable', reason: 'no_conversation' },
        ],
      },
    };
    expect(buildOtlpSummary(traces, result)).toEqual({
      cases: 2,
      excluded: { no_conversation: 1 },
      dialects: { gen_ai: 1, vercel: 1 },
      tokens: 15,
    });
  });
});

function freshProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vetkit-init-otlp-'));
  writeFileSync(join(dir, 'vetkit.config.ts'), readFileSync(join(fixtureDir, 'vetkit.config.ts')));
  return dir;
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters
function parseJson<T>(text: string): T {
  const result = safeParseJson<T>(text, {});
  if (!result.ok) throw result.error;
  return result.value;
}

interface GenerateDoc {
  readonly summary?: {
    readonly cases: number;
    readonly excluded: Record<string, number>;
    readonly dialects: Record<string, number>;
    readonly tokens: number;
  };
}

describe('vet init --source otlp:<file> --json summary', () => {
  test('the printed document carries a summary of {cases, excluded, dialects, tokens}', () => {
    const project = freshProject();
    const out = join(project, 'evals-out');
    const result = spawnSync(
      process.execPath,
      [binPath, 'init', '--source', `otlp:${otlpFixture}`, '--out', out, '--json'],
      { cwd: project, encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
    const doc = parseJson<GenerateDoc>(result.stdout);
    expect(doc.summary).toMatchObject({
      cases: expect.any(Number),
      excluded: expect.any(Object),
      dialects: expect.any(Object),
      tokens: expect.any(Number),
    });
  });
});

// <out>/summary.json must exist on disk, hold the same
// {cases, excluded, dialects, tokens} the --json stdout document carries under `summary`,
// and excluded must classify by completeness status (content_not_captured, truncated,
// incomplete_trace).
describe('vet init --source otlp: writes <out>/summary.json', () => {
  test('summary.json on disk matches stdout summary, excluded classifies by completeness', () => {
    const project = freshProject();
    const out = join(project, 'evals-out');
    const result = spawnSync(
      process.execPath,
      [binPath, 'init', '--source', `otlp:${incompleteFixture}`, '--out', out, '--json'],
      { cwd: project, encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
    const doc = parseJson<GenerateDoc>(result.stdout);

    const summaryPath = join(out, 'summary.json');
    expect(existsSync(summaryPath)).toBe(true);
    const onDisk = parseJson<GenerateDoc['summary']>(readFileSync(summaryPath, 'utf8'));

    expect(onDisk).toEqual(doc.summary);
    // incomplete.json's 4 traces, verified against source-otlp's completeness assessment:
    // one content_not_captured, two completeness-truncated, one with a missing parent span.
    expect(onDisk).toMatchObject({
      excluded: { content_not_captured: 1, truncated: 2, incomplete_trace: 1 },
    });
  });
});

// Per-copy ids only: traceId/spanId/traceIds all differ fixture-to-fixture by construction
// (each dialect fixture encodes the same conversation under its own trace/span ids), so they
// are stripped before the cross-dialect diff below; any other provenance key is left untouched.
const PER_COPY_PROVENANCE_KEYS = new Set(['traceIds', 'traceId', 'spanId']);

interface CorrelationIds {
  traceId?: unknown;
  spanId?: unknown;
}

function correlationIds(provenance: unknown): CorrelationIds {
  if (typeof provenance !== 'object' || provenance === null) return {};
  return provenance;
}

function normalizeCase(c: Case): unknown {
  const { id: _id, traceId: _traceId, provenance, ...rest } = c;
  const strippedProvenance =
    provenance !== null && typeof provenance === 'object' && !Array.isArray(provenance)
      ? Object.fromEntries(
          Object.entries(provenance).filter(([k]) => !PER_COPY_PROVENANCE_KEYS.has(k)),
        )
      : provenance;
  return { ...rest, provenance: strippedProvenance };
}

function readCases(path: string): Case[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => parseJson<Case>(line));
}

// The five dialect fixtures encode the same conversation in
// different OTel semconv styles; vet init's cases must be identical across all five once
// per-dialect ids (traceId, provenance.traceIds/traceId/spanId) are deleted, matching a
// committed golden.
describe('vet init --source otlp: dialect cases match the golden', () => {
  test('the five dialect fixtures produce identical cases after deleting per-dialect ids', () => {
    const golden = readCases(goldenInitCases).map(normalizeCase);
    expect(golden).toHaveLength(1);

    for (const dialect of dialectFixtures) {
      const project = freshProject();
      const out = join(project, 'evals-out');
      const fixture = fileURLToPath(
        new URL(`../../../../fixtures/otlp/${dialect}.json`, import.meta.url),
      );
      const result = spawnSync(
        process.execPath,
        [binPath, 'init', '--source', `otlp:${fixture}`, '--out', out, '--json'],
        { cwd: project, encoding: 'utf8' },
      );
      expect(result.status).toBe(0);

      const cases = readCases(join(out, 'cases', 'generated.jsonl'));
      // sinks correlate on provenance.traceId/spanId;
      // every OTLP-derived case must carry both, before they
      // are stripped for the cross-dialect diff below.
      for (const c of cases) {
        const ids = correlationIds(c.provenance);
        expect(typeof ids.traceId).toBe('string');
        expect(ids.traceId).not.toBe('');
        expect(typeof ids.spanId).toBe('string');
        expect(ids.spanId).not.toBe('');
      }

      expect(cases.map(normalizeCase)).toEqual(golden);
    }
  }, 30_000);
});

describe('vet init --source otlp:: SIGINT', () => {
  test('Ctrl-C during otlp::0 receiver mode closes the server and flushes cases written so far', async () => {
    const project = freshProject();
    const out = join(project, 'evals-out');
    const child = spawn(
      process.execPath,
      [binPath, 'init', '--source', 'otlp::0', '--until', '5', '--out', out, '--json'],
      { cwd: project, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    const exited = new Promise<number | null>((resolve) => {
      child.on('exit', (code) => resolve(code));
    });

    const deadline = Date.now() + 30_000;
    let port: number | undefined;
    while (port === undefined && Date.now() < deadline) {
      const match = /"listening":\{"port":(\d+)\}/.exec(stderr);
      if (match?.[1] !== undefined) port = Number(match[1]);
      else await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(port).toBeDefined();

    const body = readFileSync(otlpFixture, 'utf8');
    await fetch(`http://127.0.0.1:${String(port)}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    await new Promise((resolve) => setTimeout(resolve, 200));

    child.kill('SIGINT');
    const code = await exited;
    expect(code).not.toBeNull();
    expect(existsSync(join(out, 'cases', 'generated.jsonl'))).toBe(true);
    expect(stdout.trim().length).toBeGreaterThan(0);
  }, 60_000);
});
