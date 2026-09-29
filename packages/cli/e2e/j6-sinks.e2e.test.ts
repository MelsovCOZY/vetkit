// J6 journey (bd classified-evals-mol-7lg): `vet run --sink otel,langfuse` lands verdicts on the
// evaluated span in a collector and a local self-hosted Langfuse, and a judge failure yields
// error.type with no score. Runs scripts/smoke-j6.sh, which builds, starts docker (collector +
// Langfuse compose, TEST-ONLY), calls the REAL judge and checks every AC verify command.
//
// Final cold gate only: skipped unless CEV_E2E=1 (key from AI_GATEWAY_API_KEY or the repo .env).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const SCRIPT = join(ROOT, 'scripts/smoke-j6.sh');

function tail(output: string, lines = 60): string {
  return output.split('\n').slice(-lines).join('\n');
}

describe.skipIf(process.env['CEV_E2E'] !== '1')(
  'J6: OTel and Langfuse sinks against the real judge',
  () => {
    it('records the score on the span, error.type without score on judge failure, outbox reconciles', () => {
      const dir = mkdtempSync(join(tmpdir(), 'vetkit-e2e-j6-'));
      try {
        const result = spawnSync('bash', [SCRIPT], {
          cwd: ROOT,
          encoding: 'utf8',
          env: { ...process.env, VETKIT_SMOKE_DIR: join(dir, 'project') },
          timeout: 15 * 60 * 1000,
        });
        const diagnostics = `smoke-j6.sh exited ${String(result.status)}\n--- stdout ---\n${tail(result.stdout)}\n--- stderr ---\n${tail(result.stderr)}`;
        expect(result.status, diagnostics).toBe(0);
        expect(result.stdout, diagnostics).toContain('smoke-j6: ok');
        expect(result.stdout, diagnostics).not.toContain('NOT RUN');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  },
);
