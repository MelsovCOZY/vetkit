import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ACTION_TEXT = readFileSync(join(ROOT, 'action.yml'), 'utf8');

interface ActionStep {
  id?: string;
  name?: string;
  if?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
}

interface ActionDoc {
  inputs: Record<string, { default?: string; description?: string }>;
  outputs: Record<string, { value?: string }>;
  runs: { steps: ActionStep[] };
}

const action: ActionDoc = parse(ACTION_TEXT);

function stepByName(fragment: string): ActionStep {
  const step = action.runs.steps.find((s) => s.name?.includes(fragment));
  if (step === undefined) throw new Error(`no step named like "${fragment}"`);
  return step;
}

const THREE_HASH = 'hashFiles(inputs.criteria-files, inputs.cases-files, inputs.config-files)';

describe('action.yml: the project vet', () => {
  it("action.yml version input defaults to empty (the project's installed vet)", () => {
    expect(action.inputs['version']?.default).toBe('');
    expect(ACTION_TEXT).not.toContain('0.0.0');
  });

  it('action.yml never interpolates ${{ inputs.* }} inside a run: script', () => {
    const runs = action.runs.steps.flatMap((s) => (typeof s.run === 'string' ? [s.run] : []));
    expect(runs.length).toBeGreaterThan(0);
    for (const script of runs) expect(script).not.toMatch(/\$\{\{\s*inputs\./);
  });

  it('action.yml exposes a version output', () => {
    expect(action.outputs['version']?.value).toBe('${{ steps.run.outputs.version }}');
  });
});

describe('action.yml: the sticky comment', () => {
  it('the comment step receives ARTIFACT_URL from the upload step, REPORT_MD and COMMENT_ID', () => {
    const env = stepByName('PR comment').env ?? {};
    expect(env['ARTIFACT_URL']).toBe('${{ steps.upload.outputs.artifact-url }}');
    expect(env['REPORT_MD']).toBe('.vet/report.md');
    expect(env['COMMENT_ID']).toBe('${{ inputs.comment-id }}');
    expect(action.inputs['comment-id']?.default).toBe('');
  });

  it('the comment step passes the raw vet output as its third file', () => {
    expect(stepByName('PR comment').run).toContain(
      'comment .vet/runs/latest.json .vet/baseline/latest.json .vet/raw.json',
    );
  });

  it('the upload step has id upload and lists vet-junit.xml and the .vet report files', () => {
    const upload = stepByName('Upload');
    expect(upload.id).toBe('upload');
    const paths = String(upload.with?.['path']).split('\n');
    expect(paths).toContain('vet-junit.xml');
    expect(paths).toContain('.vet/report.md');
    expect(paths).toContain('.vet/report.html');
    expect(String(upload.with?.['include-hidden-files'])).toBe('true');
  });

  it('the upload step lists .vet/badge.json in the same artifact as the reports', () => {
    const upload = stepByName('Upload');
    expect(upload.with?.['name']).toBe('${{ inputs.artifact-name }}');
    expect(String(upload.with?.['path']).split('\n')).toContain('.vet/badge.json');
  });
});

describe('action.yml: the baseline cache key', () => {
  it('inputs cases-files and config-files exist with defaults **/cases/**/*.jsonl and vetkit.config.*', () => {
    expect(action.inputs['cases-files']?.default).toBe('**/cases/**/*.jsonl');
    expect(action.inputs['config-files']?.default).toBe('vetkit.config.*');
  });

  it('the restore key and restore-keys hash criteria-files, cases-files and config-files', () => {
    const restore = stepByName('Restore');
    expect(restore.with?.['key']).toContain(THREE_HASH);
    expect(restore.with?.['restore-keys']).toContain(THREE_HASH);
  });

  it('the save key hashes the same three inputs and ends with run_id and run_attempt', () => {
    const key = String(stepByName('Save the baseline').with?.['key']);
    expect(key).toContain(THREE_HASH);
    expect(key.endsWith('${{ github.run_id }}-${{ github.run_attempt }}')).toBe(true);
  });

  it('the restore step has id restore and runs on every pull_request event', () => {
    const restore = stepByName('Restore');
    expect(restore.id).toBe('restore');
    expect(restore.if).toContain("startsWith(github.event_name, 'pull_request')");
    expect(restore.if).not.toContain('inputs.comment');
  });

  it('the cache paths stay .vet/runs/latest.json', () => {
    expect(stepByName('Restore').with?.['path']).toBe('.vet/runs/latest.json');
    expect(stepByName('Save the baseline').with?.['path']).toBe('.vet/runs/latest.json');
  });

  it('the baseline-key output reads steps.restore.outputs.cache-primary-key', () => {
    expect(action.outputs['baseline-key']?.value).toBe(
      '${{ steps.restore.outputs.cache-primary-key }}',
    );
  });
});
