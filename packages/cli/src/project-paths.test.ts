// The evals-or-root path rule (config-load.ts projectPaths) as every command applies it: a flat
// project (`vet init --out X`: criteria.yaml and cases/ beside the config) and the scaffold's
// evals/ layout behave the same from the project root, a subdirectory, or another cwd via
// --config. Each test spawns the built bin on a private copy of fixtures/cli/run.
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, test } from 'vitest';
import { ensureCliBuilt } from './test-support/build-cli.js';

const binPath = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
const fixtureDir = fileURLToPath(new URL('../../../fixtures/cli/run', import.meta.url));
const labelsFixtureDir = fileURLToPath(new URL('../../../fixtures/labels', import.meta.url));

beforeAll(async () => {
  await ensureCliBuilt();
}, 180_000);

interface Result {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number | null;
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'vetkit-paths-'));
}

/** A private copy of the fixture project in the scaffold's evals/ layout. */
function evalsProject(): string {
  const dir = scratch();
  cpSync(fixtureDir, dir, { recursive: true });
  return dir;
}

/** The same project the way `vet init --out X` writes it: no evals/ directory. */
function flatProject(): string {
  const dir = evalsProject();
  renameSync(join(dir, 'evals', 'criteria.yaml'), join(dir, 'criteria.yaml'));
  renameSync(join(dir, 'evals', 'cases'), join(dir, 'cases'));
  rmdirSync(join(dir, 'evals'));
  return dir;
}

function configOf(root: string): string {
  return join(root, 'vetkit.config.ts');
}

function runVet(args: readonly string[], cwd: string): Result {
  return spawnSync(process.execPath, [binPath, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', VETKIT_FIXTURE_MODE: 'pass', VETKIT_FIXTURE_KEY: 'k' },
  });
}

describe('vet run: paths', () => {
  test('run: flat layout (criteria.yaml + cases/ beside the config) exits 0', () => {
    const root = flatProject();
    const result = runVet(['run'], root);
    expect(result.stderr).not.toContain('ENOENT');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('1 passed, 0 failed');
  });

  test('run: from a nested subdirectory resolves evals/ next to the config, not cwd', () => {
    const root = evalsProject();
    const sub = join(root, 'sub', 'deeper');
    mkdirSync(sub, { recursive: true });
    const result = runVet(['run'], sub);
    expect(result.stderr).not.toContain('ENOENT');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('1 passed, 0 failed');
  });
});

describe('vet validate: paths', () => {
  test('validate: flat layout fails on LABELS_TOO_FEW, never on a missing evals/criteria.yaml', () => {
    const root = flatProject();
    const result = runVet(['validate'], root);
    expect(result.stderr).toContain('LABELS_TOO_FEW');
    expect(result.stderr).not.toContain('ENOENT');
    expect(result.status).toBe(2);
  });

  test('validate --config <path> from an unrelated cwd resolves criteria and cases next to the config', () => {
    const root = flatProject();
    const result = runVet(['validate', '--config', configOf(root)], scratch());
    expect(result.stderr).toContain('LABELS_TOO_FEW');
    expect(result.stderr).not.toContain('ENOENT');
  });
});

describe('vet estimate, lock, export, watch: paths', () => {
  test('estimate: flat layout exits 0 and prints input tokens', () => {
    const root = flatProject();
    const result = runVet(['estimate'], root);
    expect(result.stderr).not.toContain('ENOENT');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('input tokens:');
  });

  test('estimate --config <path> from an unrelated cwd resolves the flat layout', () => {
    const root = flatProject();
    const result = runVet(['estimate', '--config', configOf(root)], scratch());
    expect(result.stderr).not.toContain('ENOENT');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('input tokens:');
  });

  test('lock --config <path> --help lists --config with the shared default wording', () => {
    const result = runVet(['lock', 'refresh', '--help'], scratch());
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/--config <path>/);
    expect(result.stdout).toMatch(/vetkit\.config\.\*/);
  });

  test('export --to vitest: flat layout writes under <root>/vitest, evals layout under <root>/evals/vitest', () => {
    const flat = flatProject();
    const flatResult = runVet(['export', '--to', 'vitest'], flat);
    expect(flatResult.stderr).not.toContain('ENOENT');
    expect(flatResult.status).toBe(0);
    expect(existsSync(join(flat, 'vitest'))).toBe(true);
    expect(existsSync(join(flat, 'evals'))).toBe(false);

    const scaffold = evalsProject();
    const scaffoldResult = runVet(['export', '--to', 'vitest'], scaffold);
    expect(scaffoldResult.status).toBe(0);
    expect(existsSync(join(scaffold, 'evals', 'vitest'))).toBe(true);
    expect(existsSync(join(scaffold, 'vitest'))).toBe(false);
  });

  test('watch --help lists --config <path>', () => {
    const result = runVet(['watch', '--help'], scratch());
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/--config <path>/);
  });
});

describe('config-free commands: paths', () => {
  test("lint: from a nested subdirectory lints <root>/evals/criteria.yaml (exit 0, 'no issues')", () => {
    const root = evalsProject();
    const sub = join(root, 'sub');
    mkdirSync(sub);
    const result = runVet(['lint'], sub);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('no issues');
  });

  test("lint --config <path> from an unrelated cwd lints the flat layout's criteria.yaml", () => {
    const root = flatProject();
    const result = runVet(['lint', '--config', configOf(root)], scratch());
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('no issues');
  });

  test('lint <explicit path> still wins over the config', () => {
    const elsewhere = scratch();
    cpSync(join(fixtureDir, 'evals', 'criteria.yaml'), join(elsewhere, 'mine.yaml'));
    // The config's directory holds no criteria at all, so only the explicit path can succeed.
    const emptyRoot = scratch();
    const result = runVet(['lint', 'mine.yaml', '--config', configOf(emptyRoot)], elsewhere);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('no issues');
  });

  test('cases dedupe --config <path> reads <root>/cases in the flat layout (exit 0)', () => {
    const root = flatProject();
    const result = runVet(['cases', 'dedupe', '--config', configOf(root)], scratch());
    expect(result.stderr).not.toContain('ENOENT');
    expect(result.status).toBe(0);
  });

  test('criteria disable <id> --config <path> edits the criteria file next to the config and its lock path', () => {
    const root = flatProject();
    const other = scratch();
    const disable = runVet(['criteria', 'disable', 'tone', '--config', configOf(root)], other);
    expect(disable.status).toBe(0);
    expect(readFileSync(join(root, 'criteria.yaml'), 'utf8')).toMatch(/enabled:\s*false/);
    const revalidate = runVet(
      ['criteria', 'revalidate', 'tone', '--config', configOf(root)],
      other,
    );
    expect(revalidate.status).toBe(2);
    expect(revalidate.stderr).toContain(join(root, 'criteria.lock.json'));
  });

  test('label --from <csv> --config <path> writes <root>/evals/labels', () => {
    const root = evalsProject();
    const source = readFileSync(join(labelsFixtureDir, 'answer_correct.csv'), 'utf8');
    const caseIds = source
      .split('\n')
      .slice(1)
      .filter((line) => line !== '')
      .map((line) => line.split(',')[0] ?? '');
    writeFileSync(
      join(root, 'evals', 'criteria.yaml'),
      readFileSync(join(root, 'evals', 'criteria.yaml'), 'utf8').replace(
        'id: tone',
        'id: answer_correct',
      ),
    );
    writeFileSync(
      join(root, 'evals', 'cases', 'cases.jsonl'),
      `${caseIds
        .map((id) =>
          JSON.stringify({ id, input: { state: 'User: hi' }, provenance: null, tags: [] }),
        )
        .join('\n')}\n`,
    );
    const csv = join(scratch(), 'answer_correct.csv');
    writeFileSync(csv, source);
    const result = runVet(['label', '--from', csv, '--config', configOf(root)], scratch());
    expect(result.stderr).not.toContain('ENOENT');
    expect(result.status).toBe(0);
    expect(existsSync(join(root, 'evals', 'labels', 'answer_correct.csv'))).toBe(true);
  });

  test('no config anywhere: defaults fall back to the current directory (lint exits 2 naming <cwd>/evals/criteria.yaml)', () => {
    const cwd = scratch();
    const result = runVet(['lint'], cwd);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(join(cwd, 'evals', 'criteria.yaml'));
  });
});
