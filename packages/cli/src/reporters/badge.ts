// The shields.io endpoint badge for a run. The message and colour come from the report model
// (calibration state and gate result, never a pass rate); this module only serializes and writes.
import { resolve } from 'node:path';
import { writeTextReport } from './junit.ts';
import type { ReportModel } from './report.ts';

export const BADGE_FILE = 'badge.json';

/** Exactly the four keys shields reads, in a stable order so the file diffs cleanly. */
export function badgeJson(model: ReportModel): string {
  const { schemaVersion, label, message, color } = model.badge;
  return `${JSON.stringify({ schemaVersion, label, message, color }, null, 2)}\n`;
}

/** Writes `<cacheDir>/badge.json` atomically and returns its absolute path. */
export async function writeBadge(cacheDir: string, model: ReportModel): Promise<string> {
  const target = resolve(cacheDir, BADGE_FILE);
  await writeTextReport(target, badgeJson(model));
  return target;
}
