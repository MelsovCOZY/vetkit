// J2 journey (bd classified-evals-mol-hzv): `vet init --source fixtures/traces/` generates
// criteria and cases with the REAL generator and REAL Jev judge, lint accepts the generated file
// and rejects every fixtures/lint-bad file, and `vet run` loads the generated set. Runs
// scripts/smoke-j2.sh, which checks every acceptance-criterion verify command.
//
// Final cold gate only: skipped unless CEV_E2E=1 (keys come from the environment or the repo
// .env; see the script). Counts and structure are asserted, never generated wording.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const SCRIPT = join(ROOT, 'scripts/smoke-j2.sh');

function tail(output: string, lines = 60): string {
  return output.split('\n').slice(-lines).join('\n');
}

describe.skipIf(process.env['CEV_E2E'] !== '1')(
  'J2: vet init from JSONL traces, real generator and judge',
  () => {
    it('generates >=5 criteria and >=20 cases, lints clean, and runs', () => {
      const dir = mkdtempSync(join(tmpdir(), 'vetkit-e2e-j2-'));
      try {
        const result = spawnSync('bash', [SCRIPT], {
          cwd: ROOT,
          encoding: 'utf8',
          env: { ...process.env, VETKIT_SMOKE_DIR: join(dir, 'work') },
          timeout: 14 * 60 * 1000,
        });
        const diagnostics = `smoke-j2.sh exited ${String(result.status)}\n--- stdout ---\n${tail(result.stdout)}\n--- stderr ---\n${tail(result.stderr)}`;
        // The run is the gate's single real pass: always surface the per-AC lines.
        console.log(diagnostics);
        expect(result.status, diagnostics).toBe(0);
        expect(result.stdout, diagnostics).toContain('smoke-j2: ok');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  },
);
