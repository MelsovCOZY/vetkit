import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'consumer-matrix.sh'),
  'utf8',
);

describe('consumer-matrix.sh yarn install', () => {
  it('disables immutable installs so a fresh consumer can create yarn.lock under CI=true', () => {
    const yarnInstall = SCRIPT.split('\n').find((line) => /run_step .*yarn install/.test(line));
    expect(yarnInstall).toBeDefined();
    expect(yarnInstall).toMatch(/YARN_ENABLE_IMMUTABLE_INSTALLS=false|--no-immutable/);
  });
});
