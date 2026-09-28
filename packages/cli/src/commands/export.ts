// `vet export --to <id>` (bead mol-aq4.3; root acceptance J4). Resolves a registered ExporterV1
// by id and calls doExport once per --criteria file (aq4.1 review NOTE: Criterion carries no
// source-file field, so "one describe per criteria file" is a CLI-side grouping concern, not the
// port's). The registry is a local Map, mirroring sources.ts's registerSourcePrefix: 'vitest' is
// registered by a module-scope call at import time.
import { join, relative, resolve } from 'node:path';
import { loadCases, loadCriteria, LOCK_FILE, readLockOrNull } from '@vetkit/core';
import { CEV_ERROR_CODES, VetError, type ExporterV1 } from '@vetkit/spec';
import { vitestExporter } from '@vetkit/export-vitest';
import type { Command } from 'commander';
import { loadVetConfig, type LoadedVetConfig, type LoadVetConfigOptions } from '../config-load.ts';
import { emit, getLogger, type GlobalOptions } from '../output.ts';

const DEFAULT_CRITERIA_FILES = ['evals/criteria.yaml'];

export interface ExportOptions extends GlobalOptions {
  readonly config?: string;
  readonly criteria?: string[];
  readonly cases?: string;
  readonly to?: string;
  readonly out?: string;
  readonly requireLock?: boolean;
}

export interface ExportDeps {
  /** Config loader; defaults to the CLI's shared loadVetConfig. */
  readonly loadConfig?: (
    options: LoadVetConfigOptions,
  ) => Promise<Pick<LoadedVetConfig, 'rootDir' | 'warnings'>>;
}

const exporters = new Map<string, ExporterV1>();

/** Registers (or replaces) the exporter for `--to <id>`; later calls win over earlier ones. */
export function registerExporter(id: string, exporter: ExporterV1): void {
  exporters.set(id, exporter);
}

registerExporter('vitest', vitestExporter);

function unknownTarget(id: string): VetError {
  const registered = [...exporters.keys()].join(', ') || '(none)';
  return new VetError(
    CEV_ERROR_CODES.EXPORT_TARGET_UNKNOWN,
    `unknown export target '${id}'; registered: ${registered}`,
  );
}

function noLock(lockPath: string): VetError {
  return new VetError(
    CEV_ERROR_CODES.EXPORT_NO_LOCK,
    `--require-lock: no lock file at ${lockPath}; run \`vet validate\` first`,
  );
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || !rel.startsWith('..');
}

async function exportCommand(options: ExportOptions, deps: ExportDeps): Promise<void> {
  const to = options.to ?? '';
  const exporter = exporters.get(to);
  if (exporter === undefined) throw unknownTarget(to);

  const load = deps.loadConfig ?? loadVetConfig;
  const loaded = await load({
    cwd: process.cwd(),
    requireCredentials: false,
    ...(options.config === undefined ? {} : { configPath: options.config }),
  });
  for (const warning of loaded.warnings) getLogger().warn(warning);
  const { rootDir } = loaded;

  const lockPath = join(rootDir, LOCK_FILE);
  const lock = await readLockOrNull(lockPath);
  if (options.requireLock === true && lock === null) throw noLock(lockPath);

  const outDir = resolve(options.out ?? join(rootDir, 'evals/vitest'));
  if (!isInside(rootDir, outDir)) {
    getLogger().warn(`--out ${outDir} is outside the project root ${rootDir}`);
  }

  const casesDir = resolve(options.cases ?? join(rootDir, 'evals/cases'));
  const cases = await loadCases(casesDir);
  if (!cases.ok) {
    throw new VetError(
      cases.issues[0]?.code ?? CEV_ERROR_CODES.CASE_INVALID,
      `cannot load ${casesDir}: ${cases.issues.map((i) => i.message).join('; ')}`,
    );
  }

  const criteriaFiles = options.criteria ?? DEFAULT_CRITERIA_FILES;
  const files: string[] = [];
  for (const criteriaFile of criteriaFiles) {
    const criteriaPath = resolve(rootDir, criteriaFile);
    const criteria = await loadCriteria(criteriaPath);
    if (!criteria.ok) {
      throw new VetError(
        criteria.issues[0]?.code ?? CEV_ERROR_CODES.CRITERIA_INVALID,
        `cannot load ${criteriaPath}: ${criteria.issues.map((i) => i.message).join('; ')}`,
      );
    }
    const result = await exporter.doExport({
      criteria: criteria.criteria,
      cases: cases.cases,
      lock,
      outDir,
    });
    files.push(...result.files);
  }

  emit({ files }, () => files.map((f) => `wrote ${f}`).join('\n'));
}

export function registerExport(program: Command, deps: ExportDeps = {}): Command {
  program
    .command('export')
    .description('export criteria, cases and the lock to another eval runner')
    .requiredOption('--to <id>', 'export target id (e.g. vitest)')
    .option('--out <dir>', 'output directory (default: evals/vitest next to the config)')
    .option(
      '--criteria <path...>',
      'one or more criteria files (default: evals/criteria.yaml next to the config)',
    )
    .option('--cases <dir>', 'cases directory (default: evals/cases next to the config)')
    .option('--config <path>', 'config file (default: vetkit.config.* in the current directory)')
    .option('--require-lock', 'fail with EXPORT_NO_LOCK if criteria.lock.json is missing')
    .action(async (_options: unknown, command: Command) => {
      await exportCommand(command.optsWithGlobals<ExportOptions>(), deps);
    });
  return program;
}
