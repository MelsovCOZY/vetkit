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

// Label used for the describe block when the caller passes no sourceFile.
const DEFAULT_CRITERIA_FILE = 'criteria.yaml';

/** Writes one scorer module per criterion plus one test file, all under outDir. */
export async function doExport(input: {
  criteria: Criterion[];
  cases: Case[];
  lock: Lock | null;
  outDir: string;
  sourceFile?: string;
}): Promise<{ files: string[] }> {
  const { criteria, cases, lock, outDir, sourceFile = DEFAULT_CRITERIA_FILE } = input;
  const files: string[] = [];

  for (const criterion of criteria) {
    const emitted = emitScorer(criterion, lock?.criteria[criterion.id]);
    const fullPath = join(outDir, emitted.path);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, emitted.source, 'utf8');
    files.push(fullPath);
  }

  const test = emitTestFile(sourceFile, cases, criteria, lock, { outDir });
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
