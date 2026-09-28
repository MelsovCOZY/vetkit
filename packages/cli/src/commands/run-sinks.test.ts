import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeParseJson, VetError, type PluginRef } from '@vetkit/spec';
import { beforeAll, describe, expect, test } from 'vitest';
import { resolveSinks } from '../sinks.ts';
import { ensureCliBuilt } from '../test-support/build-cli.js';

const binPath = fileURLToPath(new URL('../../dist/bin.js', import.meta.url));
const fixtureEvals = fileURLToPath(new URL('../../../../fixtures/cli/run/evals', import.meta.url));

beforeAll(async () => {
  await ensureCliBuilt();
}, 180_000);

// Two cases x one criterion: N verdicts per run.
const N = 2;
const TRACE = ['0af7651916cd43dd8448eb211c80319c', '4bf92f3577b34da6a3ce929d0e0e4736'];

// The temp project's config: an in-process judge and two fake sinks (adapter objects, option
// A). Each fake appends the verdicts it receives to the file named by FAKE_<NAME>_OUT; its
// FAKE_<NAME>_MODE is 'down' (every item rejected retryable) or 'throw' (a non-SINK error).
// The judge writes JUDGE_CALLED on every call; VETKIT_FIXTURE_MODE 'throw' makes it fail and
// 'slow' makes it wait for the abort after writing VETKIT_FIXTURE_STARTED.
const CONFIG = `import { appendFileSync, writeFileSync } from 'node:fs';

const env = process.env;
const mode = env['VETKIT_FIXTURE_MODE'] ?? 'pass';

function waitForAbort(signal) {
  return new Promise((_resolve, reject) => {
    const started = env['VETKIT_FIXTURE_STARTED'];
    if (started !== undefined) writeFileSync(started, 'started');
    const keepAlive = setTimeout(() => {}, 60_000);
    const fail = () => {
      clearTimeout(keepAlive);
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    };
    if (signal?.aborted === true) fail();
    signal?.addEventListener('abort', fail, { once: true });
  });
}

const judge = {
  specVersion: 'v1',
  id: 'fake-judge',
  capabilities: {
    questionTypes: ['boolean', 'choice', 'score'],
    maxStateTokens: 32_000,
    pinned: false,
    transport: 'fake',
    model: 'fake-jev',
  },
  async doJudge(req) {
    const marker = env['JUDGE_CALLED'];
    if (marker !== undefined) writeFileSync(marker, 'called');
    if (mode === 'throw') throw new Error('judge down');
    if (mode === 'slow') {
      if (req.state.includes('second')) await waitForAbort(req.signal);
    }
    const answers = {};
    for (const key of Object.keys(req.questions)) {
      answers[key] = {
        type: 'choice',
        choice: 'yes',
        confidence: 0.9,
        probabilities: { yes: 0.9, no: 0.1, escape: 0 },
      };
    }
    return {
      answers,
      usage: { inputTokens: 1, outputTokens: 1 },
      model: { requested: 'fake-jev', resolved: 'fake-jev-resolved', transport: 'fake', pinned: false },
    };
  },
};

function fakeSink(name, id) {
  return {
    specVersion: 'v1',
    id,
    capabilities: { batch: 10, idempotent: true },
    async doWrite(batch) {
      const sinkMode = env['FAKE_' + name + '_MODE'];
      if (sinkMode === 'throw') throw new TypeError('fake sink bug');
      if (sinkMode === 'down') {
        return {
          accepted: [],
          rejected: batch.map((v) => ({ id: v.id, reason: 'SINK_UNREACHABLE', retryable: true })),
        };
      }
      const out = env['FAKE_' + name + '_OUT'];
      if (out !== undefined) appendFileSync(out, batch.map((v) => JSON.stringify(v) + '\\n').join(''));
      return { accepted: batch.map((v) => v.id), rejected: [] };
    },
  };
}

export default {
  judge,
  sinks: [fakeSink('OTEL', 'otel/logs'), fakeSink('LANGFUSE', 'langfuse/scores'), 'named-only'],
};
`;

interface Result {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number | null;
}

interface Project {
  readonly dir: string;
  readonly otelOut: string;
  readonly langfuseOut: string;
  readonly judgeMarker: string;
}

function freshProject(): Project {
  const dir = mkdtempSync(join(tmpdir(), 'vetkit-run-sinks-'));
  cpSync(fixtureEvals, join(dir, 'evals'), { recursive: true });
  const cases = [
    { id: 'case-1', input: { state: 'User: hi\nAssistant: Hello!' }, traceId: TRACE[0] },
    { id: 'case-2', input: { state: 'User: second\nAssistant: Hi.' }, traceId: TRACE[1] },
  ].map((c, i) =>
    JSON.stringify({ ...c, provenance: { spanId: `b7ad6b716920333${String(i)}` }, tags: [] }),
  );
  writeFileSync(join(dir, 'evals', 'cases', 'cases.jsonl'), `${cases.join('\n')}\n`);
  writeFileSync(join(dir, 'vetkit.config.ts'), CONFIG);
  return {
    dir,
    otelOut: join(dir, 'otel.jsonl'),
    langfuseOut: join(dir, 'langfuse.jsonl'),
    judgeMarker: join(dir, 'judge-called'),
  };
}

function envFor(project: Project, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NO_COLOR: '1',
    FAKE_OTEL_OUT: project.otelOut,
    FAKE_LANGFUSE_OUT: project.langfuseOut,
    JUDGE_CALLED: project.judgeMarker,
    ...extra,
  };
}

function runVet(args: readonly string[], project: Project, env: NodeJS.ProcessEnv): Result {
  return spawnSync(process.execPath, [binPath, ...args], {
    cwd: project.dir,
    env,
    encoding: 'utf8',
  });
}

function parseJson(text: string): Record<string, unknown> {
  const result = safeParseJson<Record<string, unknown>>(text, {});
  if (!result.ok) throw result.error;
  return result.value;
}

function lines(text: string): string[] {
  return text.split('\n').filter((line) => line.trim() !== '');
}

function readLines(file: string): Record<string, unknown>[] {
  return existsSync(file) ? lines(readFileSync(file, 'utf8')).map(parseJson) : [];
}

describe('vet run --sink (mol-yxn.7)', () => {
  test('two sinks ok', () => {
    const project = freshProject();
    const plain = runVet(['run', '--json'], freshProject(), envFor(freshProject()));
    const result = runVet(['run', '--sink', 'otel,langfuse', '--json'], project, envFor(project));
    expect(result.status).toBe(plain.status);
    // Cross-cutting: exactly one JSON line on stdout; everything else is on stderr.
    expect(lines(result.stdout)).toHaveLength(1);
    for (const line of lines(result.stderr)) expect(line).toMatch(/^(warn|info|error) /);
    const doc = parseJson(result.stdout);
    expect(doc).toMatchObject({
      summary: { total: N },
      sinks: {
        otel: { accepted: N, rejected: 0 },
        langfuse: { accepted: N, rejected: 0 },
      },
      outbox: { produced: N, acknowledged: N, dead: 0 },
    });
    const received = readLines(project.otelOut);
    expect(received).toHaveLength(N);
    expect(readLines(project.langfuseOut)).toHaveLength(N);
    expect(received.map((v) => v['provenance'])).toEqual(
      expect.arrayContaining([
        { traceId: TRACE[0], spanId: 'b7ad6b7169203330' },
        { traceId: TRACE[1], spanId: 'b7ad6b7169203331' },
      ]),
    );
  }, 60_000);

  test('duplicate names and whitespace around commas are normalised', () => {
    const project = freshProject();
    const result = runVet(['run', '--sink', ' otel , otel ', '--json'], project, envFor(project));
    expect(result.status).toBe(0);
    expect(parseJson(result.stdout)).toMatchObject({ sinks: { otel: { accepted: N } } });
    expect(readLines(project.otelOut)).toHaveLength(N);
  }, 60_000);

  test('one sink unreachable', () => {
    const project = freshProject();
    const result = runVet(
      ['run', '--sink', 'otel,langfuse', '--json'],
      project,
      envFor(project, { FAKE_LANGFUSE_MODE: 'down' }),
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/\d+ verdicts pending in .*outbox; rerun with --sink/);
    expect(parseJson(result.stdout)).toMatchObject({
      sinks: { otel: { accepted: N, rejected: 0 }, langfuse: { accepted: 0, rejected: N } },
    });
    const outbox = join(project.dir, '.vet', 'outbox');
    expect(readLines(join(outbox, 'pending.jsonl'))).toHaveLength(N);
    const acked = readLines(join(outbox, 'acked.jsonl'));
    expect(acked.filter((l) => l['sink'] === 'langfuse/scores')).toHaveLength(0);
    expect(readLines(project.langfuseOut)).toHaveLength(0);

    // The J6 gate property: the collector comes back and a second run drains the backlog.
    const second = runVet(['run', '--sink', 'otel,langfuse', '--json'], project, envFor(project));
    expect(second.status).toBe(0);
    expect(parseJson(second.stdout)).toMatchObject({
      outbox: { produced: 2 * N, acknowledged: 2 * N },
    });
    expect(second.stderr).not.toMatch(/verdicts pending/);
  }, 60_000);

  test('unknown sink name', () => {
    const project = freshProject();
    const result = runVet(['run', '--sink', 'nope', '--json'], project, envFor(project));
    expect(result.status).toBe(2);
    expect(parseJson(result.stdout)).toMatchObject({
      error: {
        code: 'CONFIG_UNKNOWN_SINK',
        message: expect.stringMatching(/nope[\s\S]*otel\/logs/),
      },
    });
    expect(existsSync(project.judgeMarker)).toBe(false);
  }, 60_000);

  test('a bare string ref named in --sink is refused with CONFIG_UNKNOWN_SINK', () => {
    const project = freshProject();
    const result = runVet(['run', '--sink', 'named-only', '--json'], project, envFor(project));
    expect(result.status).toBe(2);
    expect(parseJson(result.stdout)).toMatchObject({
      error: { code: 'CONFIG_UNKNOWN_SINK', message: expect.stringContaining('named-only') },
    });
  }, 60_000);

  test('judge failure', () => {
    const project = freshProject();
    const plain = runVet(
      ['run', '--json'],
      freshProject(),
      envFor(freshProject(), { VETKIT_FIXTURE_MODE: 'throw' }),
    );
    const result = runVet(
      ['run', '--sink', 'otel', '--json'],
      project,
      envFor(project, { VETKIT_FIXTURE_MODE: 'throw' }),
    );
    expect(result.status).toBe(plain.status);
    const received = readLines(project.otelOut);
    expect(received).toHaveLength(N);
    for (const v of received) {
      expect(v).toMatchObject({ status: 'unscored', provenance: { traceId: expect.any(String) } });
    }
  }, 60_000);

  test('missing', () => {
    for (const args of [
      ['run', '--sink'],
      ['run', '--sink', 'absent'],
    ]) {
      const project = freshProject();
      const result = runVet(args, project, envFor(project));
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('otel/logs');
      expect(result.stderr).toContain('langfuse/scores');
      expect(result.stderr).toContain('named-only');
      expect(existsSync(project.judgeMarker)).toBe(false);
    }
  }, 60_000);

  test('a sink doWrite that throws a non-SINK error exits 70', () => {
    const project = freshProject();
    const result = runVet(
      ['run', '--sink', 'otel', '--json'],
      project,
      envFor(project, { FAKE_OTEL_MODE: 'throw' }),
    );
    expect(result.status).toBe(70);
  }, 60_000);

  test('SIGINT still enqueues and drains partial verdicts and exits 130', async () => {
    const project = freshProject();
    const started = join(project.dir, 'started');
    const child = spawn(process.execPath, [binPath, 'run', '--sink', 'otel', '--json'], {
      cwd: project.dir,
      env: envFor(project, { VETKIT_FIXTURE_MODE: 'slow', VETKIT_FIXTURE_STARTED: started }),
    });
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    const exited = new Promise<number | null>((resolve) => {
      child.on('exit', (code) => resolve(code));
    });
    const deadline = Date.now() + 30_000;
    while (!existsSync(started) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    child.kill('SIGINT');
    expect(await exited).toBe(130);
    expect(parseJson(stdout)).toMatchObject({
      summary: { aborted: true },
      sinks: { otel: { accepted: N } },
    });
    expect(readLines(project.otelOut)).toHaveLength(N);
  }, 60_000);
});

function fake(id: string): PluginRef {
  const sink = {
    specVersion: 'v1' as const,
    id,
    capabilities: { batch: 1, idempotent: true },
    doWrite: () => Promise.resolve({ accepted: [], rejected: [] }),
  };
  return sink;
}

describe('resolveSinks name matching', () => {
  const config = { sinks: [fake('otel/logs'), fake('otel/traces'), fake('langfuse/scores')] };

  test('an exact id match wins', () => {
    const [resolved] = resolveSinks(config, ['otel/logs']);
    expect(resolved?.name).toBe('otel/logs');
    expect(resolved?.sink.id).toBe('otel/logs');
  });

  test('a prefix matching exactly one ref resolves to it', () => {
    const [resolved] = resolveSinks(config, ['langfuse']);
    expect(resolved?.sink.id).toBe('langfuse/scores');
  });

  test('ambiguous prefix', () => {
    let caught: unknown;
    try {
      resolveSinks(config, ['otel']);
    } catch (error) {
      caught = error;
    }
    expect(VetError.isInstance(caught)).toBe(true);
    expect(caught).toMatchObject({
      code: 'CONFIG_UNKNOWN_SINK',
      message: expect.stringMatching(/'otel'[\s\S]*otel\/logs[\s\S]*otel\/traces/),
    });
  });

  test('a ref failing the structural check is refused with E_ADAPTER_CAPABILITY', () => {
    const broken = { specVersion: 'v1' as const, id: 'broken/sink' };
    let caught: unknown;
    try {
      resolveSinks({ sinks: [broken] }, ['broken']);
    } catch (error) {
      caught = error;
    }
    expect(VetError.isInstance(caught)).toBe(true);
    expect(caught).toMatchObject({ code: 'E_ADAPTER_CAPABILITY' });
  });
});
