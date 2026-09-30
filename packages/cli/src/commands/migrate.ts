// `vet migrate [--check] [--json]`: brings the project's schema-versioned files up to the versions
// this vetkit writes. Today that stamps `schemaVersion: 1` into criteria.yaml (comments kept) and
// confirms the lock's lockVersion is one this vetkit reads. `--check` reports without writing and
// exits 1 when something needs migrating. Run records under .vet/runs are never touched.
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import {
  checkSchemaVersion,
  CRITERIA_MIGRATIONS,
  parseCriteriaDocument,
  SCHEMA_VERSIONS,
  stampCriteriaSchemaVersion,
} from '@vetkit/core';
import { CEV_ERROR_CODES, safeParseJson, VetError } from '@vetkit/spec';
import type { Command } from 'commander';
import { projectPaths, resolveConfigFile } from '../config-load.ts';
import { CEV_EXIT, emit, type GlobalOptions } from '../output.ts';

interface MigrateOptions extends GlobalOptions {
  readonly config?: string;
  readonly check?: boolean;
}

type Action = 'stamped' | 'stamp-needed' | 'up-to-date';

interface FileReport {
  readonly path: string;
  readonly format: 'criteria' | 'lock';
  readonly from: number | null;
  readonly to: number;
  readonly action: Action;
}

async function writeAtomic(path: string, text: string): Promise<void> {
  const tmp = join(
    dirname(path),
    `${basename(path)}.${String(process.pid)}.${randomBytes(4).toString('hex')}.tmp`,
  );
  try {
    await writeFile(tmp, text);
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

function invalidCriteria(message: string): VetError {
  return new VetError(CEV_ERROR_CODES.CRITERIA_INVALID, message);
}

async function migrateCriteria(file: string, shown: string, check: boolean): Promise<FileReport> {
  const text = await readFile(file, 'utf8').catch(() => undefined);
  if (text === undefined) {
    throw new VetError(CEV_ERROR_CODES.CONFIG_INVALID, `no criteria.yaml at ${file}`);
  }
  const parsed = parseCriteriaDocument(text);
  if (!parsed.ok) throw invalidCriteria(parsed.message);
  const version = checkSchemaVersion('criteria', parsed.doc.get('schemaVersion'));
  if (!version.ok) throw invalidCriteria(version.message);
  const stamped = stampCriteriaSchemaVersion(text);
  const to = SCHEMA_VERSIONS.criteria;
  if (!stamped.changed) {
    if (CRITERIA_MIGRATIONS.length > 0 && stamped.from !== null && stamped.from < to) {
      throw invalidCriteria(`${shown}: no migration from schemaVersion ${String(stamped.from)}`);
    }
    return { path: shown, format: 'criteria', from: stamped.from, to, action: 'up-to-date' };
  }
  if (check) return { path: shown, format: 'criteria', from: null, to, action: 'stamp-needed' };
  await writeAtomic(file, stamped.text);
  return { path: shown, format: 'criteria', from: null, to, action: 'stamped' };
}

async function inspectLock(file: string, shown: string): Promise<FileReport | undefined> {
  const text = await readFile(file, 'utf8').catch(() => undefined);
  if (text === undefined) return undefined;
  const parsed = safeParseJson<{ lockVersion?: unknown }>(text, {});
  if (!parsed.ok) throw parsed.error;
  const found = parsed.value.lockVersion;
  const version = checkSchemaVersion('lock', found);
  if (!version.ok) throw new VetError(CEV_ERROR_CODES.CONFIG_INVALID, version.message);
  const from = typeof found === 'number' ? found : null;
  return { path: shown, format: 'lock', from, to: SCHEMA_VERSIONS.lock, action: 'up-to-date' };
}

function renderCheck(files: readonly FileReport[]): string {
  const pending = files.filter((f) => f.action === 'stamp-needed');
  return pending.length === 0
    ? 'up to date'
    : pending.map((f) => `${f.path}: schemaVersion missing (current ${String(f.to)})`).join('\n');
}

function renderMigrated(migrated: number): string {
  return migrated === 0
    ? 'up to date'
    : `migrated ${String(migrated)} file${migrated === 1 ? '' : 's'}`;
}

async function migrateCommand(options: MigrateOptions): Promise<void> {
  const { rootDir } = resolveConfigFile({
    cwd: process.cwd(),
    ...(options.config === undefined ? {} : { configPath: options.config }),
  });
  const paths = projectPaths(rootDir, '.vet');
  const shown = (file: string): string => relative(rootDir, file).split(sep).join('/');
  const check = options.check === true;

  // Every file is inspected before any output, so a refusal exits 2 with no partial document.
  const criteria = await migrateCriteria(paths.criteria, shown(paths.criteria), check);
  const lock = existsSync(paths.lock)
    ? await inspectLock(paths.lock, shown(paths.lock))
    : undefined;
  const files = lock === undefined ? [criteria] : [criteria, lock];
  const migrated = files.filter((f) => f.action === 'stamped').length;

  emit({ files, migrated }, () => (check ? renderCheck(files) : renderMigrated(migrated)));
  process.exitCode = files.some((f) => f.action === 'stamp-needed') ? CEV_EXIT.FAILED : CEV_EXIT.OK;
}

export function registerMigrate(program: Command): Command {
  return program
    .command('migrate')
    .description(
      'stamp schemaVersion into criteria.yaml and check the lock version (--check only reports)',
    )
    .option('--config <path>', 'config file (default: vetkit.config.* in the current directory)')
    .option('--check', 'report what would change without writing; exit 1 if anything would')
    .action(async (_options: unknown, command: Command) => {
      await migrateCommand(command.optsWithGlobals<MigrateOptions>());
    });
}
