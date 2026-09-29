// Exporter port: turns the IR (criteria, cases, lock) into files for another runner.
// Mirrors JudgeV1: a hand-written port interface with no kind field and, for v1, no
// capabilities. defineExporter only checks specVersion: no
// defineAdapter, no freeze, no marker, no runtime id check.

import type { Case, Criterion, Lock } from '../generated/index.ts';
import { assertSpecVersion } from '../registry.ts';

export interface ExporterV1 {
  specVersion: 'v1';
  id: string;
  doExport(input: {
    criteria: Criterion[];
    cases: Case[];
    lock: Lock | null;
    outDir: string;
    /** Basename of the criteria file these criteria came from, e.g. 'support.yaml'. */
    sourceFile?: string;
  }): Promise<{ files: string[] }>;
}

export function defineExporter(x: ExporterV1): ExporterV1 {
  assertSpecVersion({ specVersion: x.specVersion, id: x.id, kind: 'exporter', capabilities: {} });
  return x;
}
