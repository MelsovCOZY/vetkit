import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { VetError } from '@vetkit/spec';
import { beforeAll, describe, expect, test } from 'vitest';
import { ENV_VARS } from './commands/doctor.ts';
import { isInteractive, prompt } from './output.ts';
import { ensureCliBuilt } from './test-support/build-cli.js';

// The child imports src/ (Node strips the types): tsdown tree-shakes prompt() out of
// dist/output.js until a shipped command imports it. Workspace deps resolve to dist/.
const srcUrl = (file: string): string =>
  pathToFileURL(fileURLToPath(new URL(`./${file}`, import.meta.url))).href;
const binPath = fileURLToPath(new URL('../dist/bin.js', import.meta.url));

beforeAll(async () => {
  await ensureCliBuilt();
}, 180_000);

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const v of ENV_VARS) delete env[v.name];
  delete env.CI;
  return env;
}

describe('isInteractive', () => {
  test('is false when stdin is not a TTY', () => {
    expect(isInteractive({ isTTY: false }, {})).toBe(false);
  });

  test('is false on a TTY when CI is set', () => {
    expect(isInteractive({ isTTY: true }, { CI: 'true' })).toBe(false);
  });

  test('is true on a TTY outside CI', () => {
    expect(isInteractive({ isTTY: true }, {})).toBe(true);
  });
});

describe('prompt', () => {
  test('throws VetError NOT_INTERACTIVE naming the missing input when not interactive', async () => {
    const error: unknown = await prompt(
      { name: 'judge model', message: 'Which judge model?' },
      { stdin: { isTTY: false }, env: {} },
    ).catch((err: unknown) => err);
    expect(VetError.isInstance(error)).toBe(true);
    expect(VetError.isInstance(error) && error.code).toBe('NOT_INTERACTIVE');
    expect(error instanceof Error && error.message).toContain('judge model');
  });
});

describe('stdin closed, no TTY', () => {
  test('a command that prompts exits 2 with a message naming the missing input', () => {
    const script = `
      import { createProgram, run } from ${JSON.stringify(srcUrl('program.ts'))};
      import { prompt } from ${JSON.stringify(srcUrl('output.ts'))};
      const program = createProgram();
      program.command('needs-input').action(async () => {
        await prompt({ name: 'judge model', message: 'Which judge model?' });
      });
      run(['node', 'vet', 'needs-input'], program);
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      env: childEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5_000,
    });
    expect(result.signal).toBeNull();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('judge model');
  });

  test('vet doctor with stdin closed finishes without hanging', () => {
    const result = spawnSync(process.execPath, [binPath, 'doctor'], {
      encoding: 'utf8',
      env: childEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5_000,
    });
    expect(result.signal).toBeNull();
    expect([0, 1]).toContain(result.status);
  });
});
