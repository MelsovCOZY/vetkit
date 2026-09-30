import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import dns from 'node:dns';
import { createServer, type Server } from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JEV_PRESETS } from '@vetkit/judge-jev';
import { safeParseJson } from '@vetkit/spec';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createProgram } from './program.ts';

// vetkit contacts only the judge, generator and sinks the user configured. These tests run the
// commands in-process and record every host reached by fetch, a socket connect or a DNS lookup;
// the recorder also refuses any non-loopback destination, so a stray call cannot leave the box.
// undici's MockAgent is not used: undici is not a dependency, and the socket and lookup spies
// catch clients that bypass fetch as well.

const realFetch = globalThis.fetch;
const fixtures = fileURLToPath(new URL('../../../fixtures/cli/', import.meta.url));
const JUDGE_KEY_ENV = 'ZT_JUDGE_KEY';
const PROXY_ENV = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'];

interface Recorder {
  readonly hosts: Set<string>;
}

function hostOf(input: string): string {
  return new URL(input).host;
}

function isLoopback(host: string): boolean {
  return /^(?:127\.0\.0\.1|localhost|\[?::1\]?)(?::\d+)?$/.test(host);
}

function connectTarget(args: readonly unknown[]): string {
  // net.connect() hands Socket#connect its arguments pre-normalised as [options, callback].
  const [first, second] = Array.isArray(args[0]) ? args[0] : args;
  if (typeof first === 'object' && first !== null) {
    const host = 'host' in first && typeof first.host === 'string' ? first.host : 'localhost';
    const port = 'port' in first ? String(first.port) : '';
    if ('path' in first && typeof first.path === 'string') return `unix:${first.path}`;
    return port === '' ? host : `${host}:${port}`;
  }
  if (typeof first === 'string') return `unix:${first}`;
  const host = typeof second === 'string' ? second : 'localhost';
  return `${host}:${String(first)}`;
}

// Records every destination and refuses any that is not loopback.
function record(): Recorder {
  const hosts = new Set<string>();
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    hosts.add(hostOf(url));
    if (!isLoopback(hostOf(url))) return Promise.reject(new TypeError('fetch failed (blocked)'));
    return realFetch(input, init);
  });
  // oxlint-disable-next-line typescript/unbound-method
  const originalConnect = net.Socket.prototype.connect;
  vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(function (
    this: net.Socket,
    ...args: unknown[]
  ) {
    const target = connectTarget(args);
    hosts.add(target);
    if (!target.startsWith('unix:') && !isLoopback(target)) {
      throw new Error(`blocked connect to ${target}`);
    }
    return Reflect.apply(originalConnect, this, args);
  });
  const originalLookup = dns.lookup;
  vi.spyOn(dns, 'lookup').mockImplementation(((hostname: string, ...rest: unknown[]) => {
    hosts.add(hostname);
    if (!isLoopback(hostname)) {
      const done = rest.at(-1);
      if (typeof done === 'function') queueMicrotask(() => done(new Error('blocked lookup')));
      return {};
    }
    return Reflect.apply(originalLookup, dns, [hostname, ...rest]);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  }) as typeof dns.lookup);
  return { hosts };
}

function onlyContacted(recorder: Recorder, allowed: readonly string[]): string[] {
  return [...recorder.hosts].filter((host) => !allowed.includes(host));
}

interface Listener {
  readonly server: Server;
  readonly host: string;
  readonly url: string;
  readonly requests: string[];
}

function isNoul(question: unknown): boolean {
  return (
    typeof question === 'object' &&
    question !== null &&
    'type' in question &&
    question.type === 'noul'
  );
}

// Answers every question the way a passing judge would; also accepts any sink POST.
async function listen(): Promise<Listener> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      requests.push(`${req.method ?? ''} ${req.url ?? ''}`);
      res.setHeader('content-type', 'application/json');
      if (req.url !== '/v1/systemone') {
        res.end('{}');
        return;
      }
      const parsed = safeParseJson<unknown>(body, {});
      if (!parsed.ok) throw parsed.error;
      const raw = parsed.value;
      const asked =
        typeof raw === 'object' && raw !== null && 'questions' in raw ? raw.questions : {};
      const questions = typeof asked === 'object' && asked !== null ? Object.entries(asked) : [];
      const answers = Object.fromEntries(
        questions.map(([key, question]) => [
          key,
          isNoul(question)
            ? { type: 'noul', noul: 0.9 }
            : {
                type: 'choice',
                choice: 'yes',
                confidence: 0.9,
                probabilities: { yes: 0.9, no: 0.1, escape: 0 },
              },
        ]),
      );
      res.end(JSON.stringify({ model: 'fake-jev', answers }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  const host = `127.0.0.1:${address.port}`;
  return { server, host, url: `http://${host}`, requests };
}

const listeners: Listener[] = [];
afterEach(async () => {
  await Promise.all(
    listeners.splice(0).map((l) => new Promise<void>((resolve) => l.server.close(() => resolve()))),
  );
});

async function serve(): Promise<Listener> {
  const listener = await listen();
  listeners.push(listener);
  return listener;
}

function project(source: 'run' | 'init', config?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'vetkit-zero-telemetry-'));
  cpSync(join(fixtures, source), dir, { recursive: true });
  if (config !== undefined) writeFileSync(join(dir, 'vetkit.config.ts'), config);
  return dir;
}

function judgeConfig(sinkEndpoint?: string): string {
  const sinks =
    sinkEndpoint === undefined ? '' : `, sinks: [{ kind: 'otel', endpoint: '${sinkEndpoint}' }]`;
  return `export default { judge: { kind: 'typesafe-compatible', baseURL: 'https://judge.configured.invalid', model: 'fake-jev', apiKeyEnv: '${JUDGE_KEY_ENV}' }, thresholds: { default: 0.5, perCriterion: {} }${sinks} };\n`;
}

// Runs one `vet` invocation in-process from `cwd`; returns its exit code.
async function vet(cwd: string, args: readonly string[]): Promise<number> {
  const previous = process.cwd();
  process.chdir(cwd);
  process.exitCode = undefined;
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  try {
    await createProgram().parseAsync(['node', 'vet', ...args]);
    return typeof process.exitCode === 'number' ? process.exitCode : 0;
  } finally {
    process.chdir(previous);
    process.exitCode = undefined;
  }
}

beforeEach(() => {
  for (const name of PROXY_ENV) {
    vi.stubEnv(name, '');
    vi.stubEnv(name.toLowerCase(), '');
  }
  for (const name of ['AI_GATEWAY_API_KEY', 'TYPESAFE_API_KEY', 'OPENROUTER_API_KEY', 'CEV_DIAG']) {
    vi.stubEnv(name, '');
  }
  vi.stubEnv(JUDGE_KEY_ENV, 'zt-fake-key');
});

const CORRELATED_CASE = JSON.stringify({
  id: 'case-1',
  input: { state: 'User: hi\nAssistant: Hello! How can I help?' },
  provenance: { traceId: '00000000000000000000000000000001', spanId: '0000000000000003' },
  tags: [],
});

const DO_NOT_TRACK_VALUES = [undefined, '1'] as const;

describe.each(DO_NOT_TRACK_VALUES)('with DO_NOT_TRACK=%s', (doNotTrack) => {
  beforeEach(() => {
    vi.stubEnv('DO_NOT_TRACK', doNotTrack ?? '');
  });

  test('run contacts only the judge', async () => {
    const judge = await serve();
    vi.stubEnv('CEV_JUDGE_BASE_URL', judge.url);
    const recorder = record();
    const code = await vet(project('run', judgeConfig()), ['run', '--json']);
    expect(code).toBe(0);
    expect(judge.requests).toContain('POST /v1/systemone');
    expect(onlyContacted(recorder, [judge.host])).toEqual([]);
  });

  test('run contacts only the judge and the configured sink', async () => {
    const judge = await serve();
    const sink = await serve();
    vi.stubEnv('CEV_JUDGE_BASE_URL', judge.url);
    const recorder = record();
    const dir = project('run', judgeConfig(`${sink.url}/v1/logs`));
    // The otel sink only sends verdicts that carry a trace id.
    writeFileSync(join(dir, 'evals/cases/cases.jsonl'), `${CORRELATED_CASE}\n`);
    const code = await vet(dir, ['run', '--json', '--sink', 'otel']);
    expect(code).toBe(0);
    expect(judge.requests).toContain('POST /v1/systemone');
    expect(sink.requests.length).toBeGreaterThan(0);
    expect(onlyContacted(recorder, [judge.host, sink.host])).toEqual([]);
  });

  test('init/doctor/lint/estimate open no connections', async () => {
    const recorder = record();
    const runDir = project('run');
    const initDir = project('init');
    await vet(initDir, ['init', '--source', 'traces', '--out', join(initDir, 'out'), '--json']);
    const scaffoldDir = join(mkdtempSync(join(tmpdir(), 'vetkit-zero-telemetry-')), 'scaffold');
    mkdirSync(scaffoldDir);
    await vet(scaffoldDir, ['init', '--dir', scaffoldDir]);
    await vet(runDir, ['doctor', '--json']);
    await vet(runDir, ['lint', 'evals/criteria.yaml', '--json']);
    await vet(runDir, ['estimate', '--json']);
    expect([...recorder.hosts]).toEqual([]);
  });

  test('doctor with a judge credential probes only the preset host', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'zt-fake-gateway-key');
    const recorder = record();
    await vet(project('run'), ['doctor', '--json']);
    const presetHost = new URL(JEV_PRESETS.vercel.baseURL).host;
    expect([...recorder.hosts]).toEqual([presetHost]);
  });
});

describe('the recorder', () => {
  test('flags a fetch to an unlisted host', async () => {
    const recorder = record();
    await fetch('https://telemetry.unlisted.invalid/ping').catch(() => undefined);
    expect(onlyContacted(recorder, [])).toEqual(['telemetry.unlisted.invalid']);
  });

  test('flags a raw socket connect and a DNS lookup that bypass fetch', () => {
    const recorder = record();
    expect(() => net.connect({ host: 'raw.unlisted.invalid', port: 443 })).toThrow(/blocked/);
    dns.lookup('lookup.unlisted.invalid', () => undefined);
    expect(onlyContacted(recorder, []).toSorted()).toEqual([
      'lookup.unlisted.invalid',
      'raw.unlisted.invalid:443',
    ]);
  });

  test('a fetch to an unlisted host during a run fails the run assertion', async () => {
    const judge = await serve();
    vi.stubEnv('CEV_JUDGE_BASE_URL', judge.url);
    const recorder = record();
    await vet(project('run', judgeConfig()), ['run', '--json']);
    await fetch('https://update.unlisted.invalid/latest').catch(() => undefined);
    expect(onlyContacted(recorder, [judge.host])).toEqual(['update.unlisted.invalid']);
  });
});
