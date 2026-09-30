import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, test } from 'vitest';
import { ensureCliBuilt } from '../test-support/build-cli.js';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const binPath = fileURLToPath(new URL('../../dist/bin.js', import.meta.url));

describe('vet validate --json', () => {
  beforeAll(async () => {
    await ensureCliBuilt();
  }, 120_000);

  test('validate --json with too few labels prints exactly one document', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vetkit-validate-json-'));
    cpSync(join(repoRoot, 'fixtures/cli/run'), dir, { recursive: true });
    const result = spawnSync(process.execPath, [binPath, 'validate', '--json'], {
      cwd: dir,
      env: { ...process.env, NO_COLOR: '1', VETKIT_FIXTURE_MODE: 'pass' },
      encoding: 'utf8',
    });
    expect(result.status).toBe(2);
    const doc = JSON.parse(result.stdout) as unknown;
    expect(JSON.stringify(doc)).toContain('LABELS_TOO_FEW');
  });
});
