// `vet lock refresh`. Re-hashes each criterion's wording with the
// wording-hash normalisation (loadCriteria's wordingHash: CRLF → LF, trimmed strings; YAML comments never
// reach the parsed value) and keeps the lock entry, thresholds included, when the normalised
// wording is unchanged. When only the wordingHash differs but the entry's normalizedWordingHash
// (whitespace runs collapsed) still matches, the edit is whitespace inside a sentence: the
// wordingHash is updated in place. Any other change, and any entry without normalizedWordingHash,
// is left stale with a pointer to `vet validate`, and refresh exits 1.
import { resolve } from 'node:path';
import {
  computeNormalizedWordingHash,
  loadCriteria,
  LOCK_FILE,
  wordingOf,
  writeLockAtomic,
} from '@vetkit/core';
import { CEV_ERROR_CODES, VetError, type Lock } from '@vetkit/spec';
import type { Command } from 'commander';
import { loadVetConfig, projectPaths } from '../config-load.ts';
import { emit, getLogger, type GlobalOptions } from '../output.ts';
import { readSupportedLock } from './check.ts';
import type { ValidateDeps } from './validate.ts';

interface RefreshOptions extends GlobalOptions {
  readonly config?: string;
  readonly criteria?: string;
  readonly lock?: string;
}

interface RefreshReport {
  readonly refreshed: string[];
  readonly refreshedWhitespace: string[];
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
  const paths = loaded.paths ?? projectPaths(loaded.rootDir, loaded.config.cacheDir);
  const criteriaPath = resolve(options.criteria ?? paths.criteria);
  const lockPath = resolve(options.lock ?? paths.lock);
  const criteria = await loadCriteria(criteriaPath);
  if (!criteria.ok) {
    throw new VetError(
      criteria.issues[0]?.code ?? CEV_ERROR_CODES.CRITERIA_INVALID,
      `cannot load ${criteriaPath}: ${criteria.issues.map((i) => i.message).join('; ')}`,
    );
  }
  const lock = await readSupportedLock(lockPath);

  const report: RefreshReport = { refreshed: [], refreshedWhitespace: [], stale: [], lockPath };
  const absorbed: Lock['criteria'] = {};
  for (const c of criteria.criteria) {
    const entry = lock.criteria[c.id];
    if (entry?.wordingHash === c.wordingHash) {
      report.refreshed.push(c.id);
    } else if (
      entry?.normalizedWordingHash !== undefined &&
      entry.normalizedWordingHash === computeNormalizedWordingHash(wordingOf(c))
    ) {
      absorbed[c.id] = { ...entry, wordingHash: c.wordingHash };
      report.refreshedWhitespace.push(c.id);
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
  if (report.refreshedWhitespace.length > 0) {
    await writeLockAtomic(lockPath, { ...lock, criteria: { ...lock.criteria, ...absorbed } });
  }
  emit(report, () =>
    [
      ...report.refreshed.map((id) => `${id}: fresh`),
      ...report.refreshedWhitespace.map((id) => `${id}: refreshed (whitespace only)`),
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
    .option(
      '--criteria <file>',
      'criteria file (default: criteria.yaml next to the config, or under evals/ when that directory exists)',
    )
    .action(async (_options: unknown, command: Command) => {
      await refreshCommand(command.optsWithGlobals<RefreshOptions>(), deps);
    });
  return program;
}
