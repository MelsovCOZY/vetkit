// J3 edge journeys that need no judge answers: the built `vet`
// refuses cleanly with exit 2 and writes no lock when a criterion has too few labels, and
// `vet check --lock` on a project without a lock exits 2. The judge endpoint is a refused
// connection (CEV_JUDGE_BASE_URL) and the key is a placeholder, so no request leaves the machine.
//
// Final cold gate only: skipped unless CEV_E2E=1. Needs `bun run build`.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const BIN = join(ROOT, 'packages/cli/dist/bin.js');
const FIXTURES = join(ROOT, 'fixtures');

function vet(cwd: string, args: string[]) {
  const env = { ...process.env, AI_GATEWAY_API_KEY: 'placeholder-not-a-key' };
  return spawnSync('node', [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...env, CEV_JUDGE_BASE_URL: 'http://127.0.0.1:9' },
    timeout: 280_000,
  });
}

describe.skipIf(process.env['CEV_E2E'] !== '1')('J3: validate refusals (no judge answers)', () => {
  it(
    'too few labels: exit 2 LABELS_TOO_FEW with the count, and no lock is written',
    { timeout: 300_000 },
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'vetkit-e2e-j3-labels-'));
      try {
        cpSync(join(FIXTURES, 'projects/j3/vetkit.config.ts'), join(dir, 'vetkit.config.ts'));
        cpSync(join(FIXTURES, 'projects/j3/evals'), join(dir, 'evals'), { recursive: true });
        // 3 of the 100 answer_correct rows: below the 100-label floor (few, because a refused
        // connection is retried with backoff, so every labelled case costs seconds).
        const rows = readFileSync(join(FIXTURES, 'labels/answer_correct.csv'), 'utf8')
          .trim()
          .split('\n');
        const short = join(dir, 'short.csv');
        writeFileSync(short, `${rows.slice(0, 4).join('\n')}\n`);
        const label = vet(dir, ['label', '--from', short]);
        expect(label.status, label.stderr).toBe(0);
        const validate = vet(dir, ['validate', '--json', '--repeats', '3']);
        expect(validate.status, validate.stderr).toBe(2);
        // Under --json the error document goes to stdout.
        expect(validate.stdout).toContain('LABELS_TOO_FEW');
        expect(validate.stdout).toContain('answer_correct: 3 labels');
        expect(existsSync(join(dir, 'criteria.lock.json'))).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('vet check --lock without a lock exits 2', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vetkit-e2e-j3-nolock-'));
    try {
      cpSync(join(FIXTURES, 'projects/j3/vetkit.config.ts'), join(dir, 'vetkit.config.ts'));
      cpSync(join(FIXTURES, 'projects/j3/evals'), join(dir, 'evals'), { recursive: true });
      const check = vet(dir, ['check', '--lock', '--json']);
      expect(check.status, check.stderr).toBe(2);
      expect(existsSync(join(dir, 'criteria.lock.json'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
