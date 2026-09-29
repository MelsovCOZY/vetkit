// J3 journey: import labels, `vet validate` into criteria.lock.json,
// and gate on it, against the real Jev judge. Runs scripts/smoke-j3.sh, which builds, stages the
// fixture projects (fixtures/projects/j3, fixtures/gauntlet-fail, fixtures/labels) and checks
// every acceptance-criterion verify command.
//
// Skipped unless CEV_E2E=1 (the key comes from AI_GATEWAY_API_KEY or the
// repo .env; see the script). Thousands of live judge requests per run (the gauntlets).
// VETKIT_SMOKE_DIR keeps the scratch projects (validate reports, lock files) for inspection.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts/smoke-j3.sh');
const SMOKE_TIMEOUT_MS = 60 * 60 * 1000;

describe.skipIf(process.env['CEV_E2E'] !== '1')(
  'J3: validate and calibrate against the real judge',
  () => {
    it(
      'labels in, lock out, gate refuses uncalibrated and unpinned criteria',
      () => {
        const kept = process.env['VETKIT_SMOKE_DIR'];
        const dir = kept === undefined ? mkdtempSync(join(tmpdir(), 'vetkit-e2e-j3-')) : undefined;
        try {
          const result = spawnSync('bash', [SCRIPT], {
            cwd: ROOT,
            encoding: 'utf8',
            env: { ...process.env, VETKIT_SMOKE_DIR: kept ?? join(dir ?? tmpdir(), 'project') },
            timeout: SMOKE_TIMEOUT_MS,
            maxBuffer: 64 * 1024 * 1024,
          });
          // The script's PASS/FAIL lines are the AC-by-AC report: always show them.
          const lines = result.stdout.split('\n').filter((l) => l.startsWith('smoke-j3:'));
          console.log(lines.join('\n'));
          const diagnostics = `smoke-j3.sh exited ${String(result.status)}\n--- stderr ---\n${result.stderr.split('\n').slice(-40).join('\n')}`;
          expect(result.status, diagnostics).toBe(0);
          expect(result.stdout, diagnostics).toContain('smoke-j3: ok');
        } finally {
          if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
        }
      },
      SMOKE_TIMEOUT_MS,
    );
  },
);
