import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, test } from 'vitest';
import { ENV_VARS } from './commands/doctor.ts';
import { CEV_EXIT } from './output.ts';
import { ensureCliBuilt } from './test-support/build-cli.js';

const binPath = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
const programUrl = pathToFileURL(
  fileURLToPath(new URL('../dist/program.js', import.meta.url)),
).href;

beforeAll(async () => {
  await ensureCliBuilt();
}, 180_000);

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const v of ENV_VARS) delete env[v.name];
  delete env.CI;
  return env;
}

function runVet(args: string[]) {
  return spawnSync(process.execPath, [binPath, ...args], {
    encoding: 'utf8',
    env: childEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  });
}

describe('CEV_EXIT', () => {
  test('names the documented exit codes', () => {
    expect(CEV_EXIT).toEqual({
      OK: 0,
      FAILED: 1,
      USAGE: 2,
      UNSCORED_ONLY: 3,
      INTERNAL: 70,
      SIGINT: 130,
    });
  });
});

describe('vet exit codes', () => {
  test('--help lists the exit codes', () => {
    const result = runVet(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/exit code/i);
    for (const code of ['0', '1', '2', '3', '70', '130']) {
      expect(result.stdout).toMatch(new RegExp(`^\\s+${code}\\s`, 'm'));
    }
  });

  test('--help explains 70 as internal', () => {
    const line = runVet(['--help'])
      .stdout.split('\n')
      .find((l) => /^\s+70\s/.test(l));
    expect(line).toContain('internal');
    expect(line).toContain('--verbose');
  });

  test('--help names the outage cause for 3 and auth or billing for 2', () => {
    const lines = runVet(['--help']).stdout.split('\n');
    expect(lines.find((l) => /^\s+3\s/.test(l))).toContain('judge down or throttled');
    expect(lines.find((l) => /^\s+2\s/.test(l))).toContain('auth or billing');
  });

  test('an unknown option is a usage error (exit 2)', () => {
    expect(runVet(['--frobnicate']).status).toBe(2);
  });

  test('a failing doctor check exits 1', () => {
    // No judge credential in the child env: the judge credential row fails.
    expect(runVet(['doctor']).status).toBe(1);
  });

  test('an internal error exits 70 and its stderr names --verbose', () => {
    const script = `
      import { createProgram, run } from ${JSON.stringify(programUrl)};
      const program = createProgram();
      program.command('boom').action(() => {
        throw new Error('boom');
      });
      run(['node', 'vet', 'boom'], program);
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      env: childEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    });
    expect(result.status).toBe(70);
    expect(result.stderr).toContain('error INTERNAL: boom');
    expect(result.stderr).toContain('--verbose');
  });

  test('SIGINT exits 130', async () => {
    const script = `
      import { createProgram, run } from ${JSON.stringify(programUrl)};
      const program = createProgram();
      program.command('hang').action(async () => {
        setInterval(() => {}, 1000);
        process.stderr.write('ready\\n');
        await new Promise(() => {});
      });
      run(['node', 'vet', 'hang'], program);
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env: childEnv(),
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const status = await new Promise<number | null>((resolve) => {
      child.stderr.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('ready')) child.kill('SIGINT');
      });
      child.on('exit', (code) => resolve(code));
    });
    expect(status).toBe(130);
  }, 10_000);
});
