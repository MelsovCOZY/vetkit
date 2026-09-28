// `vet cases dedupe|quarantine|promote|review` (bead classified-evals-mol-p4a.1). All the
// actual file editing lives in @vetkit/core's cases/edit.ts; this file just wires the CLI
// group, resolves paths and reports the result.
import { join, resolve } from 'node:path';
import {
  findDuplicates,
  listPendingCases,
  loadCases,
  nearDuplicateClusters,
  promoteVerdict,
  quarantineCase,
  readRunRecord,
  removeCases,
  reviewCase,
} from '@vetkit/core';
import {
  CEV_ERROR_CODES,
  VetError,
  type Case,
  type CevErrorCode,
  type Verdict,
} from '@vetkit/spec';
import type { Command } from 'commander';
import { emit, getLogger, prompt } from '../output.ts';

export interface CasesDeps {
  readonly stdin?: { readonly isTTY?: boolean };
  readonly env?: Record<string, string | undefined>;
}

interface CasesOptions {
  readonly cases: string;
}

function loadError(
  dir: string,
  issues: readonly { readonly code: CevErrorCode; readonly message: string }[],
): VetError {
  const code = issues[0]?.code ?? CEV_ERROR_CODES.CASE_INVALID;
  return new VetError(code, `cannot load ${dir}: ${issues.map((i) => i.message).join('; ')}`);
}

async function loadCasesOrThrow(dir: string): Promise<Case[]> {
  const loaded = await loadCases(dir);
  if (!loaded.ok) throw loadError(dir, loaded.issues);
  return loaded.cases;
}

// --- dedupe ---------------------------------------------------------------------------------

interface DedupeOptions extends CasesOptions {
  readonly write?: boolean;
}

function renderDedupe(
  duplicates: readonly { readonly kept: string; readonly removed: string }[],
): string {
  return duplicates.length === 0
    ? 'none'
    : duplicates.map((d) => `kept ${d.kept}, removed ${d.removed}`).join('\n');
}

async function dedupeCommand(options: DedupeOptions): Promise<void> {
  const dir = resolve(options.cases);
  const cases = await loadCasesOrThrow(dir);
  const duplicates = findDuplicates(cases);
  const write = options.write === true;
  if (write && duplicates.length > 0) {
    await removeCases(
      dir,
      duplicates.map((d) => d.removed),
    );
  }
  // Warn-only: reported on stderr regardless of --write, and --write never acts on it.
  const nearDuplicates = nearDuplicateClusters(cases).clusters.map((c) => ({
    clusterId: c.id,
    caseIds: [...c.caseIds],
  }));
  const log = getLogger();
  for (const cluster of nearDuplicates) {
    log.warn(`near-duplicate cluster ${cluster.clusterId}: ${cluster.caseIds.join(', ')}`);
  }
  emit({ duplicates, nearDuplicates, written: write }, () => renderDedupe(duplicates));
}

// --- quarantine -------------------------------------------------------------------------------

interface QuarantineOptions extends CasesOptions {
  readonly reason: string;
}

async function quarantineCommand(id: string, options: QuarantineOptions): Promise<void> {
  const dir = resolve(options.cases);
  const result = await quarantineCase(dir, id, options.reason);
  if (result.status === 'already_quarantined') {
    getLogger().warn(`case '${id}' is already quarantined`);
  }
  emit({ id, ...result }, () => `${result.status}: ${id}`);
}

// --- promote ------------------------------------------------------------------------------

interface PromoteOptions extends CasesOptions {
  readonly cacheDir: string;
}

async function promoteCommand(verdictId: string, options: PromoteOptions): Promise<void> {
  const cacheDir = resolve(options.cacheDir);
  const recordPath = join(cacheDir, 'runs', 'latest.json');
  const record = await readRunRecord(cacheDir);
  if (record === null) {
    throw new VetError(
      CEV_ERROR_CODES.RUN_NOT_FOUND,
      `no run record at ${recordPath}; run \`vet run\` first`,
    );
  }
  // Verdict.id is only ever set when a verdict is enqueued through the outbox (vet watch);
  // `vet run`'s persisted verdicts never carry one, so the composite key rerun.ts's own
  // comparison already uses (`${caseId}:${criterionId}`) is accepted too, and is set as the
  // verdict's id below so provenance.promotedFrom.verdictId equals whatever the caller passed.
  const found = record.results.find(
    (v) => v.id === verdictId || `${v.caseId}:${v.criterionId}` === verdictId,
  );
  if (found === undefined) {
    throw new VetError(
      CEV_ERROR_CODES.RUN_NOT_FOUND,
      `verdict '${verdictId}' not found in ${recordPath}`,
    );
  }
  const verdict: Verdict = { ...found, id: verdictId };
  const dir = resolve(options.cases);
  const cases = await loadCasesOrThrow(dir);
  const evalCase = cases.find((c) => c.id === verdict.caseId);
  if (evalCase === undefined) {
    throw new VetError(
      CEV_ERROR_CODES.CASE_INVALID,
      `case '${verdict.caseId}' not found in ${dir}`,
    );
  }
  const promoted = await promoteVerdict(dir, verdict, evalCase);
  if (promoted === undefined) {
    throw new VetError(
      CEV_ERROR_CODES.CASE_INVALID,
      `cannot promote verdict '${verdictId}': it is not a failing, status 'ok' verdict, or its case has no traceId`,
    );
  }
  emit({ promoted }, () => `promoted ${promoted.id}`);
}

// --- review ---------------------------------------------------------------------------------

interface ReviewOptions extends CasesOptions {
  readonly all?: boolean;
  readonly reject?: boolean;
  readonly reason?: string;
}

function summarise(c: Case): string {
  return c.input.state.length > 80 ? `${c.input.state.slice(0, 80)}...` : c.input.state;
}

// exactOptionalPropertyTypes: `{ reason: undefined }` doesn't satisfy `{ reason?: string }`, so
// the key is left out entirely rather than set to undefined.
function reasonOption(reason: string | undefined): { readonly reason?: string } {
  return reason === undefined ? {} : { reason };
}

async function reviewCommand(
  id: string | undefined,
  options: ReviewOptions,
  deps: CasesDeps,
): Promise<void> {
  const dir = resolve(options.cases);
  const action: 'accept' | 'reject' = options.reject === true ? 'reject' : 'accept';
  if (action === 'reject' && options.reason === undefined) {
    throw new VetError(CEV_ERROR_CODES.CONFIG_INVALID, '--reject requires --reason');
  }

  if (id !== undefined) {
    const moved = await reviewCase(dir, id, action, reasonOption(options.reason));
    if (!moved) {
      throw new VetError(
        CEV_ERROR_CODES.CASE_INVALID,
        `pending case '${id}' not found in ${join(dir, 'pending')}`,
      );
    }
  } else if (options.all === true) {
    for (const p of await listPendingCases(dir)) {
      // oxlint-disable-next-line no-await-in-loop
      await reviewCase(dir, p.case.id, action, reasonOption(options.reason));
    }
  } else {
    // Interactive TTY loop: a non-TTY/CI stdin makes the first prompt() throw NOT_INTERACTIVE
    // (exit 2), before touching any pending case.
    for (const p of await listPendingCases(dir)) {
      // oxlint-disable-next-line no-await-in-loop
      const answer = (
        await prompt(
          { name: 'review', message: `${p.case.id}: ${summarise(p.case)} — accept/reject/skip?` },
          deps,
        )
      )
        .trim()
        .toLowerCase();
      if (answer.startsWith('a')) {
        // oxlint-disable-next-line no-await-in-loop
        await reviewCase(dir, p.case.id, 'accept');
      } else if (answer.startsWith('r')) {
        // oxlint-disable-next-line no-await-in-loop
        const reason = await prompt({ name: 'reason', message: 'reason for rejecting?' }, deps);
        // oxlint-disable-next-line no-await-in-loop
        await reviewCase(dir, p.case.id, 'reject', { reason });
      }
    }
  }

  const remaining = await listPendingCases(dir);
  emit({ remaining: remaining.length }, () => `${String(remaining.length)} pending case(s) remain`);
}

// --- registration -----------------------------------------------------------------------------

function withCasesOption(command: Command): Command {
  return command.option('--cases <dir>', 'cases directory', 'evals/cases');
}

export function registerCases(program: Command, deps: CasesDeps = {}): Command {
  const group = program
    .command('cases')
    .description('secondary case-set actions: dedupe, quarantine, promote, review');

  withCasesOption(group.command('dedupe'))
    .option('--write', 'remove exact-hash duplicates, keeping the earliest by id')
    .action(async (options: DedupeOptions) => {
      await dedupeCommand(options);
    });

  withCasesOption(group.command('quarantine <id>'))
    .requiredOption('--reason <text>', 'why this case is quarantined')
    .action(async (id: string, options: QuarantineOptions) => {
      await quarantineCommand(id, options);
    });

  withCasesOption(group.command('promote <verdict-id>'))
    .option('--cache-dir <dir>', 'vetkit cache directory (holds runs/latest.json)', '.vet')
    .action(async (verdictId: string, options: PromoteOptions) => {
      await promoteCommand(verdictId, options);
    });

  withCasesOption(group.command('review [id]'))
    .option('--all', 'review every pending case')
    .option('--reject', 'reject instead of accepting (requires --reason)')
    .option('--reason <text>', 'reason for --reject')
    .action(async (id: string | undefined, options: ReviewOptions) => {
      await reviewCommand(id, options, deps);
    });

  return group;
}
