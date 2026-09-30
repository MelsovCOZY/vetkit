// `vet export --to <id>` Resolves a registered ExporterV1
// by id and calls doExport once per --criteria file, passing that file's basename as sourceFile. The registry is a local Map, mirroring sources.ts's registerSourcePrefix: 'vitest' is
// registered by a module-scope call at import time.
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import { formatLoadIssues, loadCases, loadCriteria, readLockOrNull } from '@vetkit/core';
import { CEV_ERROR_CODES, VetError, type ExporterV1 } from '@vetkit/spec';
import { vitestExporter } from '@vetkit/export-vitest';
import type { Command } from 'commander';
import {
  loadVetConfig,
  projectPaths,
  type LoadedVetConfig,
  type LoadVetConfigOptions,
} from '../config-load.ts';
import { emit, getLogger, type GlobalOptions } from '../output.ts';

interface ExportOptions extends GlobalOptions {
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
  ) => Promise<
    Pick<LoadedVetConfig, 'rootDir' | 'warnings'> & Partial<Pick<LoadedVetConfig, 'paths'>>
  >;
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

// The test.include glob that reaches every emitted test file: outDir relative to rootDir
// (absolute when outDir is outside it), always with POSIX separators. Independent of `files`.
function includeGlob(rootDir: string, outDir: string): string {
  const dir = isInside(rootDir, outDir) ? relative(rootDir, outDir) : outDir;
  const posix = dir.split(sep).join('/');
  return posix === '' ? '**/*.evals.test.ts' : `${posix}/**/*.evals.test.ts`;
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

  const paths = loaded.paths ?? projectPaths(rootDir, '.vet');
  const lockPath = paths.lock;
  const lock = await readLockOrNull(lockPath);
  if (options.requireLock === true && lock === null) throw noLock(lockPath);

  const outDir = resolve(options.out ?? paths.vitestOut);
  if (!isInside(rootDir, outDir)) {
    getLogger().warn(`--out ${outDir} is outside the project root ${rootDir}`);
  }

  const casesDir = resolve(options.cases ?? paths.cases);
  const cases = await loadCases(casesDir);
  if (!cases.ok) {
    throw new VetError(
      cases.issues[0]?.code ?? CEV_ERROR_CODES.CASE_INVALID,
      formatLoadIssues(casesDir, cases.issues),
    );
  }

  const criteriaFiles = options.criteria ?? [paths.criteria];
  const files: string[] = [];
  for (const criteriaFile of criteriaFiles) {
    const criteriaPath = resolve(rootDir, criteriaFile);
    const criteria = await loadCriteria(criteriaPath);
    if (!criteria.ok) {
      throw new VetError(
        criteria.issues[0]?.code ?? CEV_ERROR_CODES.CRITERIA_INVALID,
        formatLoadIssues(criteriaPath, criteria.issues),
      );
    }
    // With more than one --criteria file each call gets its own outDir subdir named after that
    // file's basename (without extension) so multiple files' output stays apart. A single file
    // keeps outDir unchanged.
    const groupOutDir =
      criteriaFiles.length > 1
        ? join(outDir, basename(criteriaFile, extname(criteriaFile)))
        : outDir;
    const result = await exporter.doExport({
      criteria: criteria.criteria,
      cases: cases.cases,
      lock,
      outDir: groupOutDir,
      sourceFile: basename(criteriaFile),
    });
    files.push(...result.files);
  }

  const include = includeGlob(rootDir, outDir);
  emit({ files, include }, () =>
    [
      ...files.map((f) => `wrote ${f}`),
      `next: add "${include}" to test.include in vitest.config.ts (skip if your include already matches *.test.ts)`,
    ].join('\n'),
  );
}

export function registerExport(program: Command, deps: ExportDeps = {}): Command {
  program
    .command('export')
    .description('export criteria, cases and the lock to another eval runner')
    .requiredOption('--to <id>', 'export target id (e.g. vitest)')
    .option(
      '--out <dir>',
      'output directory (default: vitest next to the config, or under evals/ when that directory exists)',
    )
    .option(
      '--criteria <path...>',
      'one or more criteria files (default: criteria.yaml next to the config, or under evals/ when that directory exists)',
    )
    .option(
      '--cases <dir>',
      'cases directory (default: cases next to the config, or under evals/ when that directory exists)',
    )
    .option('--config <path>', 'config file (default: vetkit.config.* in the current directory)')
    .option('--require-lock', 'fail with EXPORT_NO_LOCK if criteria.lock.json is missing')
    .action(async (_options: unknown, command: Command) => {
      await exportCommand(command.optsWithGlobals<ExportOptions>(), deps);
    });
  return program;
}
