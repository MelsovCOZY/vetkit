// `vet check --lock|--outbox` (bead mol-p4a.2; moved out of validate.ts, q4q.6). --lock recomputes
// the lock's content hashes and compares the judge's transport, requested id and release date,
// listing each stale criterion (wording_changed | model_changed | uncalibrated = absent from the
// lock); stale exits 1, a missing or pre-v1 lock exits 2. --outbox prints the J6 outbox
// reconciliation {produced, acknowledged, dead}; a dead-lettered verdict exits 1. With both
// flags both sections print and the exit code is the larger one.
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  checkLock,
  createOutbox,
  LOCK_FILE,
  readLock,
  type ReconcileResult,
  type StaleReport,
} from '@vetkit/core';
import { CEV_ERROR_CODES, safeParseJson, VetError, type JudgeV1, type Lock } from '@vetkit/spec';
import type { Command } from 'commander';
import { loadVetConfig } from '../config-load.ts';
import { emit, getLogger } from '../output.ts';
import { loadProject, type ProjectOptions, type ValidateDeps } from './validate.ts';

interface CheckOptions extends ProjectOptions {
  readonly lock?: string | boolean;
  readonly outbox?: string | boolean;
}

export type CriterionDrift = 'wording_changed' | 'model_changed' | 'uncalibrated';

export interface LockCheckReport extends Omit<StaleReport, 'reasons'> {
  readonly reasons: (StaleReport['reasons'][number] | 'requested')[];
  readonly staleCriteria: { readonly id: string; readonly reasons: CriterionDrift[] }[];
  readonly lockPath: string;
}

/** readLock, refusing a lock written before lockVersion 1 with exit 2. */
export async function readSupportedLock(path: string): Promise<Lock> {
  const text = await readFile(path, 'utf8').catch(() => undefined);
  if (text !== undefined) {
    const raw = safeParseJson<Record<string, unknown>>(text, { type: 'object' });
    const version = raw.ok ? raw.value['lockVersion'] : undefined;
    if (typeof version === 'number' && version < 1) {
      throw new VetError(
        CEV_ERROR_CODES.CONFIG_INVALID,
        `unsupported lockVersion ${String(version)} in ${path}; run \`vet validate\` to rewrite it`,
      );
    }
  }
  const read = await readLock(path);
  if ('error' in read) throw read.error;
  return read;
}

async function describeReleaseDate(judge: JudgeV1): Promise<string | null> {
  const describe: unknown = Reflect.get(judge, 'describeModel');
  if (typeof describe !== 'function') return null;
  try {
    const described: unknown = await Reflect.apply(describe, judge, []);
    if (typeof described !== 'object' || described === null) return null;
    const date: unknown = Reflect.get(described, 'releaseDate');
    return typeof date === 'string' ? date : null;
  } catch {
    return null;
  }
}

async function checkLockFile(options: CheckOptions, deps: ValidateDeps): Promise<LockCheckReport> {
  const project = await loadProject(options, deps, false);
  const { judge, rootDir } = project.loaded;
  const lockPath = resolve(
    typeof options.lock === 'string' ? options.lock : join(rootDir, LOCK_FILE),
  );
  const lock = await readSupportedLock(lockPath);
  // Disabled criteria (`enabled: false`) have no lock entry by design; check skips them.
  const criteria = project.criteria.filter((c) => c.enabled !== false);
  const base = checkLock(lock, {
    criteria,
    cases: project.cases,
    model: {
      transport: judge.capabilities.transport,
      releaseDate: await describeReleaseDate(judge),
    },
  });
  const reasons: LockCheckReport['reasons'] = [...base.reasons];
  if (lock.model.requested !== judge.capabilities.model) reasons.push('requested');
  const modelChanged = reasons.some((r) => r !== 'wordingHash' && r !== 'datasetHash');
  const staleCriteria = criteria.flatMap((c) => {
    const entry = lock.criteria[c.id];
    const drift: CriterionDrift[] = [];
    if (entry === undefined) drift.push('uncalibrated');
    else {
      if (entry.wordingHash !== c.wordingHash) drift.push('wording_changed');
      if (modelChanged) drift.push('model_changed');
    }
    return drift.length === 0 ? [] : [{ id: c.id, reasons: drift }];
  });
  return {
    ...base,
    stale: reasons.length > 0 || staleCriteria.length > 0,
    reasons,
    staleCriteria,
    lockPath,
  };
}

async function checkOutbox(options: CheckOptions, deps: ValidateDeps): Promise<ReconcileResult> {
  let dir: string;
  if (typeof options.outbox === 'string') dir = resolve(options.outbox);
  else {
    const load = deps.loadConfig ?? loadVetConfig;
    const loaded = await load({
      cwd: process.cwd(),
      requireCredentials: false,
      ...(options.config === undefined ? {} : { configPath: options.config }),
    });
    for (const warning of loaded.warnings) getLogger().warn(warning);
    dir = resolve(loaded.rootDir, loaded.config.cacheDir, 'outbox');
  }
  return createOutbox({ dir }).reconcile();
}

function lockText(report: LockCheckReport): string {
  if (!report.stale) return `fresh: ${report.lockPath} matches the criteria and cases`;
  return [
    `stale: ${report.reasons.join(', ')}`,
    ...report.staleCriteria.map((c) => `  ${c.id}: ${c.reasons.join(', ')}`),
  ].join('\n');
}

function outboxText(r: ReconcileResult): string {
  return `outbox: ${String(r.produced)} produced, ${String(r.acknowledged)} acknowledged, ${String(r.dead)} dead`;
}

async function checkCommand(options: CheckOptions, deps: ValidateDeps): Promise<void> {
  const wantLock = options.lock !== undefined && options.lock !== false;
  const wantOutbox = options.outbox !== undefined && options.outbox !== false;
  if (!wantLock && !wantOutbox) {
    throw new VetError(
      CEV_ERROR_CODES.CONFIG_INVALID,
      '`vet check` needs --lock [path] and/or --outbox [dir]',
    );
  }
  const lock = wantLock ? await checkLockFile(options, deps) : undefined;
  const outbox = wantOutbox ? await checkOutbox(options, deps) : undefined;
  if (lock !== undefined && outbox !== undefined) {
    emit({ lock, outbox }, () => `${lockText(lock)}\n${outboxText(outbox)}`);
  } else if (lock !== undefined) {
    emit(lock, () => lockText(lock));
  } else if (outbox !== undefined) {
    emit(outbox, () => outboxText(outbox));
  }
  // Root exit-code DECISION: stale exits 1 (LOCK_STALE), missing exits 2.
  const code = Math.max(lock?.stale === true ? 1 : 0, (outbox?.dead ?? 0) > 0 ? 1 : 0);
  if (code > 0) process.exitCode = code;
}

export function registerCheck(program: Command, deps: ValidateDeps = {}): Command {
  program
    .command('check')
    .description('check criteria.lock.json and the sink outbox against the current project')
    .option('--lock [path]', 'lock file to check (default: criteria.lock.json next to the config)')
    .option('--outbox [dir]', 'outbox to reconcile (default: <cacheDir>/outbox next to the config)')
    .option('--config <path>', 'config file (default: vetkit.config.* in the current directory)')
    .option('--criteria <file>', 'criteria file (default: evals/criteria.yaml next to the config)')
    .option('--cases <dir>', 'cases directory (default: evals/cases next to the config)')
    .action(async (_options: unknown, command: Command) => {
      await checkCommand(command.optsWithGlobals<CheckOptions>(), deps);
    });
  return program;
}
