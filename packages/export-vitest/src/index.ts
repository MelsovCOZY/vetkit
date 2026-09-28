import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  defineExporter,
  type Case,
  type Criterion,
  type ExporterV1,
  type Lock,
} from '@vetkit/spec';
import { emitScorer } from './emit-scorer.ts';
import { emitTestFile } from './emit-test.ts';

export { emitScorer } from './emit-scorer.ts';
export type { EmitScorerOptions, EmitScorerResult } from './emit-scorer.ts';
export { emitTestFile } from './emit-test.ts';
export type { EmitTestFileOptions, EmitTestFileResult } from './emit-test.ts';

// ExporterV1's input carries no source-file field (aq4.1 review NOTE: Criterion has none
// either), so this default name stands in for "the criteria" on a single doExport call; the
// CLI (packages/cli/src/commands/export.ts) is what groups multiple --criteria files and calls
// doExport once per file.
const DEFAULT_CRITERIA_FILE = 'criteria.yaml';

/** Writes one scorer module per criterion plus one test file, all under outDir. */
export async function doExport(input: {
  criteria: Criterion[];
  cases: Case[];
  lock: Lock | null;
  outDir: string;
}): Promise<{ files: string[] }> {
  const { criteria, cases, lock, outDir } = input;
  const files: string[] = [];

  for (const criterion of criteria) {
    const emitted = emitScorer(criterion, lock?.criteria[criterion.id]);
    const fullPath = join(outDir, emitted.path);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, emitted.source, 'utf8');
    files.push(fullPath);
  }

  const test = emitTestFile(DEFAULT_CRITERIA_FILE, cases, criteria, lock, { outDir });
  const testFullPath = join(outDir, test.path);
  await mkdir(dirname(testFullPath), { recursive: true });
  await writeFile(testFullPath, test.source, 'utf8');
  files.push(testFullPath);

  return { files };
}

export const vitestExporter: ExporterV1 = defineExporter({
  specVersion: 'v1',
  id: 'vitest',
  doExport,
});
