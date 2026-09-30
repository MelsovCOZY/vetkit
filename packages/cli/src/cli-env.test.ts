// `vet run` loads .env / .env.local next to the resolved config. A fake systemone judge
// (fixtures/cli/judge-http/server.mjs) records which Bearer token reached it; the canary
// value must never appear in stdout, stderr or anything written under .vet/.
import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import { ensureCliBuilt } from './test-support/build-cli.ts';

const binPath = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
const serverPath = fileURLToPath(
  new URL('../../../fixtures/cli/judge-http/server.mjs', import.meta.url),
);
const evalsDir = fileURLToPath(new URL('../../../fixtures/cli/run/evals', import.meta.url));
const KEY_ENV = 'VETKIT_TEST_JUDGE_KEY';
const CANARY = 'canary-0123456789-abcdefghijklmnopqrstuv';
const CANARY_LOCAL = 'canary-local-9876543210-zyxwvutsrqponmlkj';

beforeAll(async () => {
  await ensureCliBuilt();
}, 180_000);

interface FakeJudge {
  readonly baseURL: string;
  readonly child: ChildProcess;
  readonly lines: string[];
}

const running: ChildProcess[] = [];
afterEach(() => {
  for (const child of running.splice(0)) child.kill('SIGTERM');
});

async function startJudge(key: string): Promise<FakeJudge> {
  const child = spawn(process.execPath, [serverPath, '--key', key], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running.push(child);
  const lines: string[] = [];
  let buffer = '';
  const baseURL = await new Promise<string>((resolve, reject) => {
    child.once('error', reject);
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const parts = buffer.split('\n');
      buffer = parts.pop() ?? '';
      for (const line of parts) {
        const match = /^listening (http:\/\/127\.0\.0\.1:\d+)$/.exec(line);
        if (match?.[1] !== undefined) resolve(match[1]);
        else lines.push(line);
      }
    });
  });
  child.stdout?.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) if (line !== '') lines.push(line);
  });
  return { baseURL, child, lines };
}

function project(baseURL: string, files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'vetkit-cli-env-'));
  cpSync(evalsDir, join(dir, 'evals'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  writeFileSync(
    join(dir, 'vetkit.config.js'),
    `export default { judge: ${JSON.stringify({ kind: 'typesafe-compatible', baseURL, model: 'fake/jev', apiKeyEnv: KEY_ENV })} };\n`,
  );
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', ...extra };
  for (const name of [
    KEY_ENV,
    'AI_GATEWAY_API_KEY',
    'TYPESAFE_API_KEY',
    'OPENROUTER_API_KEY',
    'CLOUDFLARE_API_TOKEN',
    'CEV_JUDGE_BASE_URL',
  ]) {
    if (!(name in extra)) delete env[name];
  }
  return env;
}

// Async on purpose: spawnSync would block this worker's event loop, so the fake judge's
// stdout lines could not be collected until after the CLI had exited.
async function vet(
  cwd: string,
  args: string[],
  extra: Record<string, string> = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [binPath, ...args], {
    cwd,
    env: cleanEnv(extra),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const status = await new Promise<number | null>((resolve) => {
    child.once('close', resolve);
  });
  return { status, stdout, stderr };
}

function filesUnder(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true, recursive: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name));
  } catch {
    return [];
  }
}

describe('vet run loads .env next to the config', () => {
  test('a key in .env reaches the judge with no export', async () => {
    const judge = await startJudge(CANARY);
    const dir = project(judge.baseURL, { '.env': `${KEY_ENV}=${CANARY}\n` });
    const result = await vet(dir, ['run']);
    expect(result.status).toBe(0);
    expect(judge.lines).toContain('auth ok');
    expect(judge.lines).not.toContain('auth fail');
  });

  test('process env beats .env', async () => {
    const judge = await startJudge('other');
    const dir = project(judge.baseURL, { '.env': `${KEY_ENV}=${CANARY}\n` });
    const result = await vet(dir, ['run'], { [KEY_ENV]: 'other' });
    expect(result.status).toBe(0);
    expect(judge.lines).toContain('auth ok');
  });

  test('.env.local beats .env', async () => {
    const judge = await startJudge(CANARY_LOCAL);
    const dir = project(judge.baseURL, {
      '.env': `${KEY_ENV}=${CANARY}\n`,
      '.env.local': `${KEY_ENV}=${CANARY_LOCAL}\n`,
    });
    const result = await vet(dir, ['run']);
    expect(result.status).toBe(0);
    expect(judge.lines).toContain('auth ok');
  });

  test('--no-env-file leaves the key unset: exit 2 naming VETKIT_TEST_JUDGE_KEY', async () => {
    const judge = await startJudge(CANARY);
    const dir = project(judge.baseURL, { '.env': `${KEY_ENV}=${CANARY}\n` });
    const result = await vet(dir, ['--no-env-file', 'run']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(KEY_ENV);
  });

  test('the .env value never appears in stdout, stderr or any file under .vet/', async () => {
    const judge = await startJudge(CANARY);
    const dir = project(judge.baseURL, { '.env': `${KEY_ENV}=${CANARY}\n` });
    for (const args of [
      ['run', '--verbose'],
      ['run', '--verbose', '--json'],
    ]) {
      const result = await vet(dir, args);
      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain(CANARY);
      expect(result.stderr).not.toContain(CANARY);
    }
    const produced = filesUnder(join(dir, '.vet'));
    expect(produced.length).toBeGreaterThan(0);
    const hits = produced.filter((file) => readFileSync(file, 'utf8').includes(CANARY));
    expect(hits).toEqual([]);
  });

  test("--config <path> in another directory loads that directory's .env, not cwd's", async () => {
    const judge = await startJudge(CANARY);
    const other = project(judge.baseURL, { '.env': `${KEY_ENV}=${CANARY}\n` });
    const cwd = mkdtempSync(join(tmpdir(), 'vetkit-cli-env-cwd-'));
    mkdirSync(join(cwd, 'sub'));
    writeFileSync(join(cwd, '.env'), `${KEY_ENV}=wrong-key-from-cwd\n`);
    const result = await vet(cwd, ['run', '--config', join(other, 'vetkit.config.js')]);
    expect(result.status).toBe(0);
    expect(judge.lines).toContain('auth ok');
    expect(judge.lines).not.toContain('auth fail');
  });

  test('--verbose prints the env-file path and a count but no name or value', async () => {
    const judge = await startJudge(CANARY);
    const dir = project(judge.baseURL, { '.env': `${KEY_ENV}=${CANARY}\n` });
    const result = await vet(dir, ['run', '--verbose']);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain(`env files: ${join(dir, '.env')} (1 variables)`);
    expect(result.stderr).not.toContain(KEY_ENV);
    expect(result.stderr).not.toContain(CANARY);
  });
});
