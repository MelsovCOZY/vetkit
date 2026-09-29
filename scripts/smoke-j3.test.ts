import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts/smoke-j3.sh');
const src = readFileSync(SCRIPT, 'utf8');

describe('scripts/smoke-j3.sh transport selection', () => {
  test('an unknown CEV_SMOKE_JUDGE exits non-zero naming the variable, before any build', () => {
    const run = spawnSync('bash', [SCRIPT], {
      encoding: 'utf8',
      env: { ...process.env, CEV_SMOKE_JUDGE: 'bogus', AI_GATEWAY_API_KEY: 'x' },
      timeout: 20_000,
    });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('CEV_SMOKE_JUDGE');
    expect(run.stdout).not.toContain('building');
  });

  test('the key env and preflight probe follow the selected transport', () => {
    expect(src).toContain('CEV_SMOKE_JUDGE:-vercel');
    expect(src).toContain('KEY_ENV=OPENROUTER_API_KEY');
    expect(src).toContain('https://openrouter.ai/api/v1/systemone');
    expect(src).toContain('https://ai-gateway.vercel.sh/typesafe/v1/systemone');
  });

  test('AC3a asserts GATE_UNPINNED only on the unpinned transport, else that --ci passes', () => {
    const start = src.indexOf('vet c1 run --ci');
    const end = src.indexOf('vet c2 run --ci');
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, end);
    expect(block).toMatch(/if \[ "\$JUDGE" = vercel \]/);
    expect(block).toContain('GATE_UNPINNED');
    expect(block).toMatch(/pinned lock\) -> exit 0/);
  });

  test('the refused-connection edge runs an uncached case', () => {
    const start = src.indexOf('say "P3 vet run');
    const end = src.indexOf('vet u1 run');
    const block = src.slice(start, end);
    expect(block).not.toContain('head -1 passcases/pass.jsonl >onecase');
    expect(block).toMatch(/uncached/);
  });
});
