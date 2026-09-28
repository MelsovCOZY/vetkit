// Plain Node test runner: `node --test action/run.test.mjs`. No network: `vet` is a shim script
// on PATH that never calls out.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const RUN_SH = fileURLToPath(new URL('./run.sh', import.meta.url));

/** A `vet` shim on its own PATH entry, so run.sh finds it ahead of any real vetkit. */
function vetShim(script) {
  const dir = mkdtempSync(join(tmpdir(), 'vetkit-vet-shim-'));
  const bin = join(dir, 'vet');
  writeFileSync(bin, script);
  chmodSync(bin, 0o755);
  return dir;
}

function runAction(cwd, binDir) {
  return spawnSync('bash', [RUN_SH, 'run'], {
    cwd,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      GITHUB_OUTPUT: join(cwd, 'github_output.txt'),
      INPUT_CONFIG: '',
      INPUT_GATE: 'false',
      INPUT_ALLOW_UNPINNED: 'false',
    },
    encoding: 'utf8',
  });
}

void test('run.sh keeps the RunRecord vet already wrote instead of overwriting it with --json stdout', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vetkit-run-'));
  const bin = vetShim(`#!/usr/bin/env bash
set -euo pipefail
mkdir -p .vet/runs
cat > .vet/runs/latest.json <<'EOF'
{"summary":{"passed":3,"failed":0,"unscored":0},"model":{"requested":"m"},"results":[],"criteriaPath":"criteria.yaml","casesPath":"cases.yaml","startedAt":"2026-09-28T00:00:00.000Z"}
EOF
echo '{"summary":{"passed":3,"failed":0,"unscored":0},"model":{"requested":"m"},"results":[]}'
`);

  const result = runAction(dir, bin);

  assert.equal(result.status, 0, result.stderr);
  const record = JSON.parse(readFileSync(join(dir, '.vet/runs/latest.json'), 'utf8'));
  assert.equal(record.criteriaPath, 'criteria.yaml');
  assert.equal(record.casesPath, 'cases.yaml');
  assert.equal(record.startedAt, '2026-09-28T00:00:00.000Z');
});

void test('run.sh falls back to the --json output when vet does not persist its own record', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vetkit-run-'));
  const bin = vetShim(`#!/usr/bin/env bash
set -euo pipefail
echo '{"summary":{"passed":1,"failed":2,"unscored":0},"model":{"requested":"m"},"results":[]}'
`);

  const result = runAction(dir, bin);

  assert.equal(result.status, 0, result.stderr);
  const record = JSON.parse(readFileSync(join(dir, '.vet/runs/latest.json'), 'utf8'));
  assert.equal(record.summary.passed, 1);
  assert.equal(record.summary.failed, 2);
});
