// `vet label`: import human labels from CSV (`--from`) or collect them in a TTY loop
// (`--tty`), writing `evals/labels/<criterion_id>.csv`.
import { closeSync, existsSync, fsyncSync, openSync, statSync, writeSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { isCancel, selectKey } from '@clack/prompts';
import {
  formatLabelRow,
  LABEL_CSV_HEADER,
  loadCases,
  loadCriteria,
  loadLabels,
  parseLabels,
  type LabelIdSets,
  type LabelIssue,
  type LabelRow,
  type LabelValue,
} from '@vetkit/core';
import { CEV_ERROR_CODES, VetError, type Case, type Criterion } from '@vetkit/spec';
import type { Command } from 'commander';
import { findConfigFile, projectPaths, type ProjectPaths } from '../config-load.ts';

interface WritableLike {
  write(chunk: string): unknown;
}

export interface LabelDeps {
  /** Terminal input for `--tty`; must report `isTTY`. Defaults to process.stdin. */
  readonly input?: Readable & { readonly isTTY?: boolean };
  /** Terminal output for `--tty`. Defaults to process.stdout. */
  readonly output?: Writable;
  /** Where duplicate-row warnings go. Defaults to process.stderr. */
  readonly stderr?: WritableLike;
  readonly now?: () => Date;
  readonly env?: Record<string, string | undefined>;
}

interface LabelOptions {
  readonly from?: string;
  readonly tty?: boolean;
  readonly cases: string;
  readonly criteria: string;
  readonly labels: string;
  readonly labeler?: string;
}

interface LabelCliOptions extends Partial<Omit<LabelOptions, 'from' | 'tty' | 'labeler'>> {
  readonly from?: string;
  readonly tty?: boolean;
  readonly labeler?: string;
  readonly config?: string;
}

// `vet label` never loads the config (no judge, no credential): only its directory matters, so an
// explicit --config is located, not read; without one the nearest discovered config's directory
// (else the current directory) is the project root. Explicit --cases/--criteria/--labels stay
// cwd-relative.
function defaultPaths(config: string | undefined): ProjectPaths {
  const cwd = process.cwd();
  const file = config === undefined ? findConfigFile(cwd) : resolve(config);
  if (file === undefined) {
    // No config anywhere: nothing to anchor to, so today's cwd-relative evals/ defaults.
    const evals = join(cwd, 'evals');
    return {
      ...projectPaths(cwd, '.vet'),
      criteria: join(evals, 'criteria.yaml'),
      cases: join(evals, 'cases'),
      labels: join(evals, 'labels'),
    };
  }
  return projectPaths(dirname(file), '.vet');
}

interface Project {
  readonly cases: Case[];
  readonly criteria: Criterion[];
  readonly ids: LabelIdSets;
}

function describeIssues(issues: readonly LabelIssue[]): string {
  return issues.map((i) => `${i.file}:${i.line}: ${i.message}`).join('\n');
}

async function loadProject(options: LabelOptions): Promise<Project> {
  const cases = await loadCases(options.cases);
  if (!cases.ok) {
    const detail = cases.issues.map((i) => `${i.file}:${i.line}: ${i.message}`).join('\n');
    throw new VetError(CEV_ERROR_CODES.CASE_INVALID, detail);
  }
  const criteria = await loadCriteria(options.criteria);
  if (!criteria.ok) {
    const detail = criteria.issues.map((i) => `${options.criteria}${i.path}: ${i.message}`);
    throw new VetError(CEV_ERROR_CODES.CRITERIA_INVALID, detail.join('\n'));
  }
  return {
    cases: cases.cases,
    criteria: criteria.criteria,
    ids: {
      caseIds: new Set(cases.cases.map((c) => c.id)),
      criterionIds: new Set(criteria.criteria.map((c) => c.id)),
    },
  };
}

async function csvFiles(path: string): Promise<string[]> {
  if (!statSync(path).isDirectory()) return [path];
  const entries = await readdir(path, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.csv'))
    .map((e) => join(path, e.name))
    .toSorted();
}

async function importLabels(options: LabelOptions, from: string, deps: LabelDeps): Promise<void> {
  const stderr = deps.stderr ?? process.stderr;
  const { ids } = await loadProject(options);
  const issues: LabelIssue[] = [];
  const imported: LabelRow[] = [];
  for (const file of await csvFiles(from)) {
    const result = parseLabels(await readFile(file, 'utf8'), file, ids);
    if (!result.ok) {
      issues.push(...result.issues);
      continue;
    }
    imported.push(...result.rows);
    for (const w of result.warnings) stderr.write(`warning ${w.file}:${w.line}: ${w.message}\n`);
  }
  if (issues.length > 0) {
    throw new VetError(CEV_ERROR_CODES.LABELS_INVALID, describeIssues(issues));
  }

  const byCriterion = new Map<string, LabelRow[]>();
  for (const row of imported) {
    byCriterion.set(row.criterionId, [...(byCriterion.get(row.criterionId) ?? []), row]);
  }
  await mkdir(options.labels, { recursive: true });
  for (const [criterionId, rows] of byCriterion) {
    const target = join(options.labels, `${criterionId}.csv`);
    const merged = new Map<string, LabelRow>();
    if (existsSync(target)) {
      const existing = parseLabels(await readFile(target, 'utf8'), target, ids);
      if (!existing.ok) {
        throw new VetError(CEV_ERROR_CODES.LABELS_INVALID, describeIssues(existing.issues));
      }
      for (const row of existing.rows) merged.set(row.caseId, row);
    }
    for (const row of rows) {
      merged.delete(row.caseId);
      merged.set(row.caseId, row);
    }
    const body = [...merged.values()].map(formatLabelRow).join('\n');
    await writeFile(target, `${LABEL_CSV_HEADER}\n${body}\n`);
  }
}

// Append + fsync per row, so an interrupted session keeps every row answered so far.
function appendRow(dir: string, row: LabelRow): void {
  const target = join(dir, `${row.criterionId}.csv`);
  const fresh = !existsSync(target) || statSync(target).size === 0;
  const fd = openSync(target, 'a');
  try {
    writeSync(fd, `${fresh ? `${LABEL_CSV_HEADER}\n` : ''}${formatLabelRow(row)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

const KEYS = [
  { value: 'p', label: 'pass' },
  { value: 'f', label: 'fail' },
  { value: 'u', label: 'unknown' },
  { value: 'q', label: 'save and quit' },
] as const;
const LABEL_FOR_KEY: Readonly<Record<string, LabelValue>> = { p: 'pass', f: 'fail', u: 'unknown' };

async function labelLoop(options: LabelOptions, deps: LabelDeps): Promise<void> {
  const input = deps.input ?? process.stdin;
  const output = deps.output ?? process.stdout;
  // Guard before any prompt: clack hangs without a TTY.
  if (input.isTTY !== true) {
    throw new VetError(
      CEV_ERROR_CODES.NOT_INTERACTIVE,
      '`vet label --tty` needs an interactive terminal; use `vet label --from <csv>` instead',
    );
  }
  const project = await loadProject(options);
  const labeled = new Set<string>();
  if (existsSync(options.labels)) {
    const existing = await loadLabels(options.labels, project.ids);
    if (!existing.ok) {
      throw new VetError(CEV_ERROR_CODES.LABELS_INVALID, describeIssues(existing.issues));
    }
    for (const [criterionId, entries] of existing.labels) {
      for (const e of entries) labeled.add(`${criterionId}\u0000${e.caseId}`);
    }
  }
  const pending = project.criteria.flatMap((criterion) =>
    project.cases
      .filter((c) => !labeled.has(`${criterion.id}\u0000${c.id}`))
      .map((c) => ({ criterion, c })),
  );

  const now = deps.now ?? (() => new Date());
  const labeler = options.labeler ?? (deps.env ?? process.env)['USER'] ?? 'unknown';
  await mkdir(options.labels, { recursive: true });
  for (const [index, { criterion, c }] of pending.entries()) {
    const answer = c.input.answer === undefined ? '' : `\nAnswer:\n${c.input.answer}\n`;
    output.write(
      `\n── case ${c.id} · criterion ${criterion.id}\n${c.input.state}\n${answer}` +
        `\nInstructions: ${criterion.instructions.trim()}\n`,
    );
    const choice = await selectKey({
      input,
      output,
      message: `label ${c.id} × ${criterion.id} (${index + 1}/${pending.length})`,
      options: [...KEYS],
    });
    // q, Ctrl-C or Esc: rows answered so far are already on disk.
    if (isCancel(choice)) break;
    const value = LABEL_FOR_KEY[choice];
    if (value === undefined) break;
    appendRow(options.labels, {
      caseId: c.id,
      criterionId: criterion.id,
      label: value,
      labeler,
      labeledAt: now().toISOString(),
    });
  }
}

export function registerLabel(program: Command, deps: LabelDeps = {}): Command {
  return program
    .command('label')
    .description('import human labels from CSV or collect them in a terminal loop')
    .option('--from <path>', 'a labels CSV file or a directory of them to import')
    .option('--tty', 'label unlabeled (case, criterion) pairs interactively')
    .option('--config <path>', 'config file (default: vetkit.config.* in the current directory)')
    .option(
      '--cases <dir>',
      'cases directory (default: cases next to the config, or under evals/ when that directory exists)',
    )
    .option(
      '--criteria <file>',
      'criteria file (default: criteria.yaml next to the config, or under evals/ when that directory exists)',
    )
    .option(
      '--labels <dir>',
      'labels directory to write (default: labels next to the config, or under evals/ when that directory exists)',
    )
    .option('--labeler <name>', 'labeler name recorded on each --tty row (default: $USER)')
    .action(async (cliOptions: LabelCliOptions) => {
      if ((cliOptions.from === undefined) === (cliOptions.tty !== true)) {
        throw new VetError(CEV_ERROR_CODES.CONFIG_INVALID, 'pass exactly one of --from or --tty');
      }
      const paths = defaultPaths(cliOptions.config);
      const options: LabelOptions = {
        ...cliOptions,
        cases: cliOptions.cases ?? paths.cases,
        criteria: cliOptions.criteria ?? paths.criteria,
        labels: cliOptions.labels ?? paths.labels,
      };
      if (options.from !== undefined) await importLabels(options, options.from, deps);
      else await labelLoop(options, deps);
    });
}
