// One renderer for "cannot load" failures: every issue on its own line, located by the
// criteria file plus JSON Pointer (criteria issues) or by file:line (case issues), so a
// developer fixes all of them in one pass instead of one per run.

export interface LoadIssue {
  readonly message: string;
  /** Criteria issues: a JSON Pointer into the file. */
  readonly path?: string;
  /** Case issues: the file and 1-based line (0 when the file itself could not be read). */
  readonly file?: string;
  readonly line?: number;
  readonly relatedPath?: string;
}

function issueLine(source: string, issue: LoadIssue): string {
  const where =
    issue.file === undefined
      ? `${source}${issue.path ?? ''}`
      : `${issue.file}${issue.line === undefined || issue.line === 0 ? '' : `:${String(issue.line)}`}`;
  const related = issue.relatedPath === undefined ? '' : ` (also at ${issue.relatedPath})`;
  return `${where}: ${issue.message}${related}`;
}

/** `cannot load <source>:` followed by one `<where>: <message>` line per issue. */
export function formatLoadIssues(source: string, issues: readonly LoadIssue[]): string {
  return [`cannot load ${source}:`, ...issues.map((i) => issueLine(source, i))].join('\n');
}
