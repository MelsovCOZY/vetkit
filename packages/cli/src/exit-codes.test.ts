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
    expect(CEV_EXIT).toMatchObject({ OK: 0, FAILED: 1, USAGE: 2, UNSCORED_ONLY: 3, SIGINT: 130 });
  });
});

describe('vet exit codes', () => {
  test('--help lists the exit codes', () => {
    const result = runVet(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/exit code/i);
    for (const code of ['0', '1', '2', '3', '130']) {
      expect(result.stdout).toMatch(new RegExp(`^\\s+${code}\\s`, 'm'));
    }
  });

  test('an unknown option is a usage error (exit 2)', () => {
    expect(runVet(['--frobnicate']).status).toBe(2);
  });

  test('a failing doctor check exits 1', () => {
    // No judge credential in the child env: the judge credential row fails.
    expect(runVet(['doctor']).status).toBe(1);
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
