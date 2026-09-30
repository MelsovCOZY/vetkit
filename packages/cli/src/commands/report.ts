// `vet report`: render the last run record as Markdown and HTML files without judging anything.
// The badge is written by `vet run` only, so a report can never rewrite CI state after the fact.
import { relative, resolve } from 'node:path';
import { readRunRecord } from '@vetkit/core';
import { CEV_ERROR_CODES, VetError } from '@vetkit/spec';
import type { Command } from 'commander';
import { loadVetConfig } from '../config-load.ts';
import { CEV_EXIT, emit, getLogger, type GlobalOptions } from '../output.ts';
import { renderHtml } from '../reporters/html.ts';
import { DEFAULT_HTML_PATH, DEFAULT_MD_PATH, writeTextReport } from '../reporters/junit.ts';
import {
  buildReportModel,
  loadReportInputs,
  renderMarkdown,
  VETKIT_VERSION,
} from '../reporters/report.ts';

interface ReportOptions extends GlobalOptions {
  readonly config?: string;
  readonly md?: string;
  readonly html?: string;
  readonly includeCases?: boolean;
  readonly stdout?: boolean;
}

async function reportCommand(options: ReportOptions): Promise<void> {
  const log = getLogger();
  const cwd = process.cwd();
  const loaded = await loadVetConfig({
    cwd,
    ...(options.config === undefined ? {} : { configPath: options.config }),
  });
  for (const warning of loaded.warnings) log.warn(warning);
  const { rootDir, paths } = loaded;
  const { cacheDir } = paths;

  const record = await readRunRecord(cacheDir);
  if (record === null) {
    throw new VetError(
      CEV_ERROR_CODES.RUN_NOT_FOUND,
      `no run record at ${resolve(cacheDir, 'runs', 'latest.json')}; run \`vet run\` first`,
    );
  }
  const includeCases = options.includeCases === true;
  const inputs = await loadReportInputs({ rootDir, record, includeCases });
  for (const warning of inputs.warnings) log.warn(warning);
  const model = buildReportModel({
    record,
    criteria: inputs.criteria,
    lock: inputs.lock,
    ...(inputs.cases === undefined ? {} : { cases: inputs.cases }),
    includeCases,
    vetkitVersion: VETKIT_VERSION,
  });

  if (options.stdout === true) {
    process.stdout.write(renderMarkdown(model));
    process.exitCode = CEV_EXIT.OK;
    return;
  }
  const md = resolve(cwd, options.md ?? DEFAULT_MD_PATH);
  const html = resolve(cwd, options.html ?? DEFAULT_HTML_PATH);
  await writeTextReport(md, renderMarkdown(model));
  await writeTextReport(html, renderHtml(model));
  emit({ md, html }, () =>
    [`report: ${relative(cwd, md)}`, `report: ${relative(cwd, html)}`].join('\n'),
  );
  // A report of a failed run is still a successful report.
  process.exitCode = CEV_EXIT.OK;
}

export function registerReport(program: Command): Command {
  return program
    .command('report')
    .description('render the last run as Markdown and HTML report files without judging')
    .option('--config <path>', 'config file (default: vetkit.config.* in the current directory)')
    .option('--md <file>', `Markdown report path (default ${DEFAULT_MD_PATH})`)
    .option('--html <file>', `HTML report path (default ${DEFAULT_HTML_PATH})`)
    .option('--include-cases', 'put case ids and (redacted, truncated) case text in the reports')
    .option('--stdout', 'print only the Markdown to stdout and write no files (wins over --json)')
    .action(async (_options: unknown, command: Command) => {
      await reportCommand(command.optsWithGlobals<ReportOptions>());
    });
}
