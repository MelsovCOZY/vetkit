// Drift guard: the shipped TS corpora under ./corpora/ must stay byte-identical to
// their fixtures/gauntlet/*.json source of truth (still read directly by gauntlet-controls.test.ts
// and gauntlet-bias.test.ts), so a fixture edit that forgets the TS copy fails loudly here.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { safeParseJson } from '@vetkit/spec';
import { CONSTANT_OUTPUTS } from './corpora/constant-outputs.ts';
import { INJECTIONS } from './corpora/injections.ts';
import { MASTER_KEYS } from './corpora/master-keys.ts';
import { PADDINGS } from './corpora/padding.ts';
import { DEFAULT_GAUNTLET_CORPORA } from './corpora.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const FIXTURES = join(REPO_ROOT, 'fixtures', 'gauntlet');

function loadFixture<T>(file: string, key: string): T[] {
  const parsed = safeParseJson<Record<string, T[]>>(readFileSync(join(FIXTURES, file), 'utf8'), {});
  if (!parsed.ok) throw parsed.error;
  const value = parsed.value[key];
  if (value === undefined) throw new Error(`${file} has no '${key}' key`);
  return value;
}

describe('shipped gauntlet corpora match fixtures/gauntlet/*.json', () => {
  it('INJECTIONS deep-equals fixtures/gauntlet/injections.json', () => {
    expect(INJECTIONS).toEqual(loadFixture('injections.json', 'injections'));
  });

  it('MASTER_KEYS deep-equals fixtures/gauntlet/master-keys.json', () => {
    expect(MASTER_KEYS).toEqual(loadFixture('master-keys.json', 'inputs'));
  });

  it('CONSTANT_OUTPUTS deep-equals fixtures/gauntlet/constant-outputs.json', () => {
    expect(CONSTANT_OUTPUTS).toEqual(loadFixture('constant-outputs.json', 'constants'));
  });

  it('PADDINGS deep-equals fixtures/gauntlet/padding.json', () => {
    expect(PADDINGS).toEqual(loadFixture('padding.json', 'paddings'));
  });
});

describe('DEFAULT_GAUNTLET_CORPORA', () => {
  it('aggregates the four corpora under injections, masterKeys, constants and paddings', () => {
    expect(DEFAULT_GAUNTLET_CORPORA).toEqual({
      injections: INJECTIONS,
      masterKeys: MASTER_KEYS,
      constants: CONSTANT_OUTPUTS,
      paddings: PADDINGS,
    });
  });
});
