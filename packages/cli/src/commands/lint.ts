// `vet lint [path] [--json]`: lints a hand-written criteria.yaml against
// Jev's documented weak spots (core's lintCriteria) without running anything. Exit 1 when
// any issue is error-severity (those criteria are the ones `vet init --source`'s own lint
// pass would drop); exit 0 otherwise, including on warn-only issues.
import { dirname, join, resolve } from 'node:path';
import { lintCriteria, loadCriteria, type LintIssue } from '@vetkit/core';
import { CEV_ERROR_CODES, VetError } from '@vetkit/spec';
import type { Command } from 'commander';
import { findConfigFile, projectPaths } from '../config-load.ts';
import { CEV_EXIT, emit, type GlobalOptions } from '../output.ts';

interface LintOptions extends GlobalOptions {
  readonly config?: string;
}

// Never loads the config (no judge, no credential): only its directory matters, so an explicit
// --config is located, not read.
function defaultCriteriaPath(config: string | undefined): string {
  const cwd = process.cwd();
  const file = config === undefined ? findConfigFile(cwd) : resolve(config);
  // No config anywhere: nothing to anchor to, so today's cwd-relative evals/ default.
  if (file === undefined) return join(cwd, 'evals', 'criteria.yaml');
  return projectPaths(dirname(file), '.vet').criteria;
}

function renderIssue(issue: LintIssue): string {
  return `${issue.severity} ${issue.ruleId}\t${issue.criterionId}\t${issue.path}\t${issue.message}`;
}

function renderIssues(issues: readonly LintIssue[]): string {
  return issues.length === 0 ? 'no issues' : issues.map(renderIssue).join('\n');
}

async function lintCommand(path: string | undefined, options: LintOptions): Promise<void> {
  const file = resolve(path ?? defaultCriteriaPath(options.config));
  const loaded = await loadCriteria(file);
  if (!loaded.ok) {
    const [issue] = loaded.issues;
    // An unreadable default path (no criteria.yaml where the config points) is a usage error
    // (exit 2), not an internal I/O failure (exit 70).
    const code = issue?.code === 'E_IO' ? undefined : issue?.code;
    throw new VetError(
      code ?? CEV_ERROR_CODES.CRITERIA_INVALID,
      issue === undefined
        ? `invalid criteria file: ${file}`
        : [
            `cannot load ${file}:`,
            ...loaded.issues.map((i) => {
              const related = i.relatedPath === undefined ? '' : ` (also at ${i.relatedPath})`;
              return `${file}${i.path}: ${i.message}${related}`;
            }),
          ].join('\n'),
    );
  }
  const issues = lintCriteria(loaded.criteria);
  emit({ issues }, () => renderIssues(issues));
  process.exitCode = issues.some((issue) => issue.severity === 'error')
    ? CEV_EXIT.FAILED
    : CEV_EXIT.OK;
}

export function registerLint(program: Command): Command {
  return program
    .command('lint [path]')
    .description(
      'lint criteria.yaml against Jev wording weak spots (default: criteria.yaml next to the config, or under evals/ when that directory exists)',
    )
    .option('--config <path>', 'config file (default: vetkit.config.* in the current directory)')
    .action(async (path: string | undefined, _options: unknown, command: Command) => {
      await lintCommand(path, command.optsWithGlobals<LintOptions>());
    });
}
