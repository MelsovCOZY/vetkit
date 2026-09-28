// `vet lock refresh` (bead mol-p4a.2). Re-hashes each criterion's wording with the J3
// normalisation (loadCriteria's wordingHash: CRLF → LF, trimmed strings; YAML comments never
// reach the parsed value) and keeps the lock entry, thresholds included, when the normalised
// wording is unchanged. Any other change is left stale with a pointer to `vet validate`, and
// refresh exits 1. The lock stores only the hash, so an edit the normalisation does not absorb
// (e.g. whitespace inside a sentence) cannot be told apart from a semantic one and stays stale.
import { join, resolve } from 'node:path';
import { loadCriteria, LOCK_FILE } from '@vetkit/core';
import { CEV_ERROR_CODES, VetError } from '@vetkit/spec';
import type { Command } from 'commander';
import { loadVetConfig } from '../config-load.ts';
import { emit, getLogger, type GlobalOptions } from '../output.ts';
import { readSupportedLock } from './check.ts';
import type { ValidateDeps } from './validate.ts';

interface RefreshOptions extends GlobalOptions {
  readonly config?: string;
  readonly criteria?: string;
  readonly lock?: string;
}

export interface RefreshReport {
  readonly refreshed: string[];
  readonly stale: { readonly id: string; readonly message: string }[];
  readonly lockPath: string;
}

async function refreshCommand(options: RefreshOptions, deps: ValidateDeps): Promise<void> {
  const load = deps.loadConfig ?? loadVetConfig;
  const loaded = await load({
    cwd: process.cwd(),
    requireCredentials: false,
    ...(options.config === undefined ? {} : { configPath: options.config }),
  });
  for (const warning of loaded.warnings) getLogger().warn(warning);
  const criteriaPath = resolve(options.criteria ?? join(loaded.rootDir, 'evals/criteria.yaml'));
  const lockPath = resolve(options.lock ?? join(loaded.rootDir, LOCK_FILE));
  const criteria = await loadCriteria(criteriaPath);
  if (!criteria.ok) {
    throw new VetError(
      criteria.issues[0]?.code ?? CEV_ERROR_CODES.CRITERIA_INVALID,
      `cannot load ${criteriaPath}: ${criteria.issues.map((i) => i.message).join('; ')}`,
    );
  }
  const lock = await readSupportedLock(lockPath);

  const report: RefreshReport = { refreshed: [], stale: [], lockPath };
  for (const c of criteria.criteria) {
    const entry = lock.criteria[c.id];
    if (entry?.wordingHash === c.wordingHash) {
      report.refreshed.push(c.id);
    } else {
      report.stale.push({
        id: c.id,
        message:
          entry === undefined
            ? `'${c.id}' is not in ${LOCK_FILE}; run \`vet validate\` to calibrate it`
            : `the wording of '${c.id}' changed beyond whitespace and comments; run \`vet validate\` to recalibrate it`,
      });
    }
  }
  emit(report, () =>
    [
      ...report.refreshed.map((id) => `${id}: fresh`),
      ...report.stale.map((s) => `${s.id}: stale (${s.message})`),
    ].join('\n'),
  );
  if (report.stale.length > 0) process.exitCode = 1;
}

export function registerLock(program: Command, deps: ValidateDeps = {}): Command {
  const lock = program.command('lock').description('maintain criteria.lock.json');
  lock
    .command('refresh')
    .description(
      're-hash criteria wording and keep lock entries whose normalised text is unchanged',
    )
    .option('--lock <path>', 'lock file (default: criteria.lock.json next to the config)')
    .option('--config <path>', 'config file (default: vetkit.config.* in the current directory)')
    .option('--criteria <file>', 'criteria file (default: evals/criteria.yaml next to the config)')
    .action(async (_options: unknown, command: Command) => {
      await refreshCommand(command.optsWithGlobals<RefreshOptions>(), deps);
    });
  return program;
}
