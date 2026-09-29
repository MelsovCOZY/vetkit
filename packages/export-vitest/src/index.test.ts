import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { Criterion } from '@vetkit/spec';
import { afterEach, describe, expect, test } from 'vitest';
import { doExport } from './index.ts';

const HASH = 'a'.repeat(64);
const criterion = {
  id: 'helpful',
  type: 'boolean',
  instructions: 'Is the reply helpful?',
  escape: 'not answerable',
  polarity: 'pass_when_true',
  channel: 'quality',
  provenance: { traceIds: [] },
  wordingHash: HASH,
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
} as Criterion;

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function run(sourceFile?: string): Promise<{ name: string; source: string }> {
  const outDir = await mkdtemp(join(tmpdir(), 'vetkit-doexport-'));
  dirs.push(outDir);
  const { files } = await doExport({
    criteria: [criterion],
    cases: [],
    lock: null,
    outDir,
    ...(sourceFile === undefined ? {} : { sourceFile }),
  });
  const testFile = files.find((f) => f.endsWith('.evals.test.ts'));
  if (testFile === undefined) throw new Error('no test file emitted');
  return { name: basename(testFile), source: await readFile(testFile, 'utf8') };
}

describe('doExport describe label', () => {
  test('names the describe block and file after sourceFile', async () => {
    const { name, source } = await run('support.yaml');
    expect(name).toBe('support.yaml.evals.test.ts');
    expect(source).toContain('describe("support.yaml"');
    expect(source).not.toContain('describe("criteria.yaml"');
  });

  test("falls back to 'criteria.yaml' when sourceFile is absent", async () => {
    const { name, source } = await run();
    expect(name).toBe('criteria.yaml.evals.test.ts');
    expect(source).toContain('describe("criteria.yaml"');
  });
});
