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

describe('consumer-matrix.sh bin aliases', () => {
  it('runs npx vetkit --version and npx vet --version without -y', () => {
    const lines = SCRIPT.split('\n');
    for (const bin of ['vet', 'vetkit']) {
      const step = lines.find((line) => line.includes(`npx ${bin} --version`));
      expect(step).toBeDefined();
      expect(step).not.toMatch(/npx -y/);
    }
    expect(SCRIPT).not.toMatch(/npx -y vet(kit)? --version/);
  });

  it('compares the two version outputs', () => {
    expect(SCRIPT).toMatch(/versions agree/);
    expect(SCRIPT).toMatch(/vet_v/);
    expect(SCRIPT).toMatch(/vetkit_v/);
    expect(SCRIPT).toMatch(/expected/);
  });
});
