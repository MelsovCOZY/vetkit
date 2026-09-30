import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JEV_CREDENTIAL_PRIORITY, JEV_PRESETS } from '@vetkit/judge-jev';
import { loadLabels, parseLabels } from '@vetkit/core';
import { safeParseJson } from '@vetkit/spec';
import { beforeAll, describe, expect, test } from 'vitest';
import { ensureCliBuilt } from '../test-support/build-cli.js';
import { GATE_TARGET, renderGeneratorBlock } from './init-gate.ts';

const binPath = fileURLToPath(new URL('../../dist/bin.js', import.meta.url));
const templatesDir = fileURLToPath(new URL('../../templates/', import.meta.url));

beforeAll(async () => {
  await ensureCliBuilt();
}, 180_000);

function scaffold(args: readonly string[] = []): {
  dir: string;
  stdout: string;
  status: number | null;
} {
  const dir = mkdtempSync(join(tmpdir(), 'vetkit-gate-'));
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
  for (const p of JEV_CREDENTIAL_PRIORITY) {
    for (const c of JEV_PRESETS[p].credentials) delete env[c.name];
  }
  delete env['CI'];
  const result = spawnSync(process.execPath, [binPath, 'init', ...args], {
    cwd: dir,
    env,
    encoding: 'utf8',
  });
  return { dir, stdout: result.stdout, status: result.status };
}

describe('vet init gate scaffold', () => {
  test('writes evals/labels.csv.example with the canonical header and one row per scaffold case', () => {
    const { dir, status } = scaffold();
    expect(status).toBe(0);
    expect(GATE_TARGET.path).toBe('evals/labels.csv.example');
    const lines = readFileSync(join(dir, 'evals/labels.csv.example'), 'utf8')
      .split('\n')
      .filter((line) => line !== '');
    expect(lines[0]).toBe('case_id,criterion_id,label,labeler,labeled_at');
    expect(lines).toHaveLength(4);
    expect(lines.some((line) => line.startsWith('#'))).toBe(false);
    const rows = lines.slice(1).map((line) => line.split(','));
    expect(rows.map((r) => [r[0], r[1], r[2]])).toEqual([
      ['refund-issued', 'refund-issued', 'pass'],
      ['refund-partial', 'refund-issued', 'fail'],
      ['no-refund-topic', 'refund-issued', 'unknown'],
    ]);
    for (const r of rows) {
      expect(r[3]).toBe('you');
      expect(Number.isNaN(Date.parse(r[4] ?? ''))).toBe(false);
    }
  });

  test('the example parses with parseLabels once named .csv', () => {
    const text = readFileSync(join(templatesDir, 'labels.csv.example'), 'utf8');
    const parsed = parseLabels(text, 'refund-issued.csv');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.rows).toHaveLength(3);
    expect(parsed.warnings).toEqual([]);
  });

  test('vet validate never reads the example (loadLabels on evals/ finds no labels)', async () => {
    const { dir } = scaffold();
    const loaded = await loadLabels(join(dir, 'evals'));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.labels.size).toBe(0);
  });

  test('the config template carries a commented generator block with no vendor host', () => {
    const rendered = renderGeneratorBlock('a,{{generator}}\nb');
    expect(rendered).not.toContain('{{');
    const block = rendered.split('\n').filter((line) => line.trim().startsWith('//'));
    const text = block.join('\n');
    expect(text).toContain('// generator:');
    expect(text).toContain("kind: 'openai-compatible'");
    expect(text).toContain("baseURL: 'https://<your-openai-compatible-endpoint>/v1'");
    expect(text).toContain("apiKeyEnv: 'GENERATOR_API_KEY'");
    expect(text).toContain("model: '<model id>'");
    expect(text).toMatch(/paraphrase.*polarity.*skipped|polarity.*paraphrase.*skipped/is);
    expect(rendered).not.toMatch(/vercel|typesafe|openrouter|cloudflare|openai\.com/i);
    const { dir } = scaffold();
    const config = readFileSync(join(dir, 'vetkit.config.ts'), 'utf8');
    expect(config).toContain('// generator:');
    expect(config).not.toContain('{{');
  });

  test('--json lists the example file', () => {
    const { stdout } = scaffold(['--json']);
    const doc = safeParseJson<{ files: string[] }>(stdout, {});
    expect(doc.ok && doc.value.files).toContain('evals/labels.csv.example');
  });
});
