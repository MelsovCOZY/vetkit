import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeParseJson } from '@vetkit/spec';
import { beforeAll, describe, expect, test } from 'vitest';
import { ensureCliBuilt } from '../test-support/build-cli.js';

const binPath = fileURLToPath(new URL('../../dist/bin.js', import.meta.url));
const fixtureDir = fileURLToPath(new URL('../../../../fixtures/cli/run', import.meta.url));

beforeAll(async () => {
  await ensureCliBuilt();
}, 180_000);

const CRITERIA = `# hand-written criteria
criteria:
  # politeness
  - id: tone
    type: boolean
    instructions: Is the reply polite?
    escape: The reply has no discernible tone.
    polarity: pass_when_true
    channel: quality
    provenance:
      traceIds: []
  - id: greets # keep this one
    type: boolean
    instructions: Does the reply greet the user?
    escape: The reply is empty.
    polarity: pass_when_true
    channel: quality
    provenance:
      traceIds: []
`;

const GAUNTLET = {
  paraphrase: 'pass',
  polarity: 'pass',
  injection: 'pass',
  master_key: 'pass',
  label_permutation: 'pass',
  constant_output: 'pass',
  position_swap: 'pass',
  length: 'pass',
};

function lockEntry(): Record<string, unknown> {
  return {
    wordingHash: 'a'.repeat(64),
    status: 'floating',
    threshold: 0.5,
    tolerance: 0,
    gauntlet: GAUNTLET,
    reasons: [],
    labelCount: 120,
  };
}

// The fake-judge fixture project, with a second criterion and a floating lock for both.
function project(withLock = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'vetkit-criteria-'));
  cpSync(fixtureDir, dir, { recursive: true });
  writeFileSync(join(dir, 'evals', 'criteria.yaml'), CRITERIA);
  if (withLock) {
    const lock = {
      lockVersion: 1,
      model: {
        requested: 'fake-jev-pass',
        resolved: 'fake-jev-pass',
        transport: 'fake',
        pinned: false,
      },
      criteria: { tone: lockEntry(), greets: lockEntry() },
      datasetHash: 'd'.repeat(64),
    };
    writeFileSync(join(dir, 'criteria.lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
  }
  return dir;
}

interface Result {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number | null;
}

function runVet(args: readonly string[], cwd: string): Result {
  const env = { ...process.env, NO_COLOR: '1', VETKIT_FIXTURE_MODE: 'pass' };
  return spawnSync(process.execPath, [binPath, ...args], { cwd, env, encoding: 'utf8' });
}

function parseJson(text: string): Record<string, unknown> {
  const result = safeParseJson<Record<string, unknown>>(text, { type: 'object' });
  if (!result.ok) throw result.error;
  return result.value;
}

function criteriaText(dir: string): string {
  return readFileSync(join(dir, 'evals', 'criteria.yaml'), 'utf8');
}

interface LockShape {
  readonly criteria: Record<string, Record<string, unknown>>;
}

function lockCriteria(dir: string): Record<string, Record<string, unknown>> {
  const text = readFileSync(join(dir, 'criteria.lock.json'), 'utf8');
  const result = safeParseJson<LockShape>(text, { type: 'object', required: ['criteria'] });
  if (!result.ok) throw result.error;
  return result.value.criteria;
}

describe('vet criteria disable', () => {
  test('disable writes enabled: false on that criterion, keeping comments and order', () => {
    const dir = project();
    const result = runVet(['criteria', 'disable', 'greets'], dir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(join(dir, 'evals', 'criteria.yaml'));
    const text = criteriaText(dir);
    expect(text).toContain('# hand-written criteria');
    expect(text).toContain('# politeness');
    expect(text).toContain('# keep this one');
    expect(text.indexOf('- id: tone')).toBeLessThan(text.indexOf('- id: greets'));
    expect(text.slice(text.indexOf('- id: greets'))).toContain('enabled: false');
    expect(text.slice(0, text.indexOf('- id: greets'))).not.toContain('enabled');
  });

  test('vet run then reports the disabled criterion as not_applicable', () => {
    const dir = project();
    expect(runVet(['criteria', 'disable', 'greets'], dir).status).toBe(0);
    const run = runVet(['run', '--json'], dir);

    expect(run.status).toBe(0);
    expect(parseJson(run.stdout)).toMatchObject({
      results: expect.arrayContaining([
        expect.objectContaining({
          criterionId: 'greets',
          status: 'not_applicable',
          cause: 'disabled',
        }),
        expect.objectContaining({ criterionId: 'tone', status: 'ok' }),
      ]),
    });
  });

  test('enable again removes enabled: false', () => {
    const dir = project();
    expect(runVet(['criteria', 'disable', 'greets'], dir).status).toBe(0);
    const result = runVet(['criteria', 'enable', 'greets'], dir);

    expect(result.status).toBe(0);
    expect(criteriaText(dir)).not.toContain('enabled');
    expect(criteriaText(dir)).toContain('# keep this one');
  });

  test('an unknown id exits 2 and leaves criteria.yaml untouched', () => {
    const dir = project();
    const result = runVet(['criteria', 'disable', 'ghost'], dir);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('ghost');
    expect(criteriaText(dir)).toBe(CRITERIA);
  });

  test('disable works without a lock', () => {
    const dir = project(false);
    expect(runVet(['criteria', 'disable', 'greets'], dir).status).toBe(0);
  });
});

describe('vet criteria delete', () => {
  test('delete removes the criterion and its lock entry and prints both paths', () => {
    const dir = project();
    const result = runVet(['criteria', 'delete', 'greets'], dir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(join(dir, 'evals', 'criteria.yaml'));
    expect(result.stdout).toContain(join(dir, 'criteria.lock.json'));
    expect(criteriaText(dir)).not.toContain('greets');
    expect(criteriaText(dir)).toContain('# politeness');
    expect(Object.keys(lockCriteria(dir))).toEqual(['tone']);
  });

  test('--json prints {removed, files}', () => {
    const dir = project();
    const result = runVet(['--json', 'criteria', 'delete', 'greets'], dir);

    expect(result.status).toBe(0);
    expect(parseJson(result.stdout)).toEqual({
      removed: 'greets',
      files: [join(dir, 'evals', 'criteria.yaml'), join(dir, 'criteria.lock.json')],
    });
  });

  test('a file under evals/ that references the id is listed in a warning; delete proceeds', () => {
    const dir = project();
    mkdirSync(join(dir, 'evals', 'labels'), { recursive: true });
    const labels = join(dir, 'evals', 'labels', 'greets.csv');
    writeFileSync(
      labels,
      'case_id,criterion_id,label,labeler,labeled_at\ncase-1,greets,pass,a,x\n',
    );
    const result = runVet(['criteria', 'delete', 'greets'], dir);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain(labels);
    expect(criteriaText(dir)).not.toContain('greets');
  });

  test('a file in the --export dir that references the id is listed in a warning', () => {
    const dir = project();
    const exportDir = join(dir, 'tests', 'evals');
    mkdirSync(exportDir, { recursive: true });
    const exported = join(exportDir, 'greets.test.ts');
    writeFileSync(exported, "test('greets', () => {});\n");
    const result = runVet(['criteria', 'delete', 'greets', '--export', exportDir], dir);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain(exported);
  });

  test('delete without a lock edits only criteria.yaml', () => {
    const dir = project(false);
    const result = runVet(['--json', 'criteria', 'delete', 'greets'], dir);

    expect(result.status).toBe(0);
    expect(parseJson(result.stdout)).toEqual({
      removed: 'greets',
      files: [join(dir, 'evals', 'criteria.yaml')],
    });
  });

  test('an unknown id exits 2', () => {
    expect(runVet(['criteria', 'delete', 'ghost'], project()).status).toBe(2);
  });
});

describe('vet criteria revalidate', () => {
  test('revalidate marks the lock entry uncalibrated and clears its threshold', () => {
    const dir = project();
    const result = runVet(['criteria', 'revalidate', 'greets'], dir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(join(dir, 'criteria.lock.json'));
    const entries = lockCriteria(dir);
    expect(entries['greets']?.['status']).toBe('uncalibrated');
    expect(entries['greets']?.['threshold']).toBeUndefined();
    expect(entries['tone']?.['status']).toBe('floating');
  });

  test('vet run --gate then refuses until vet validate runs again', () => {
    const dir = project();
    expect(runVet(['run', '--gate', '--allow-unpinned'], dir).status).toBe(0);
    expect(runVet(['criteria', 'revalidate', 'greets'], dir).status).toBe(0);
    const gated = runVet(['run', '--gate', '--allow-unpinned'], dir);

    expect(gated.status).toBe(2);
    expect(`${gated.stdout}${gated.stderr}`).toContain('greets');
  });

  test('no lock exits 2 with no criteria.lock.json', () => {
    const result = runVet(['criteria', 'revalidate', 'greets'], project(false));

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('no criteria.lock.json');
  });

  test('an id missing from the lock exits 2', () => {
    expect(runVet(['criteria', 'revalidate', 'ghost'], project()).status).toBe(2);
  });
});
