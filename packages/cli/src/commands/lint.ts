// `vet lint [path] [--json]`: lints a hand-written criteria.yaml against
// Jev's documented weak spots (core's lintCriteria) without running anything. Exit 1 when
// any issue is error-severity (those criteria are the ones `vet init --source`'s own lint
// pass would drop); exit 0 otherwise, including on warn-only issues.
import { resolve } from 'node:path';
import { lintCriteria, loadCriteria, type LintIssue } from '@vetkit/core';
import { CEV_ERROR_CODES, VetError } from '@vetkit/spec';
import type { Command } from 'commander';
import { CEV_EXIT, emit, type GlobalOptions } from '../output.ts';

const DEFAULT_CRITERIA_PATH = 'evals/criteria.yaml';

function renderIssue(issue: LintIssue): string {
  return `${issue.severity} ${issue.ruleId}\t${issue.criterionId}\t${issue.path}\t${issue.message}`;
}

function renderIssues(issues: readonly LintIssue[]): string {
  return issues.length === 0 ? 'no issues' : issues.map(renderIssue).join('\n');
}

async function lintCommand(path: string, _options: GlobalOptions): Promise<void> {
  const file = resolve(path);
  const loaded = await loadCriteria(file);
  if (!loaded.ok) {
    const [issue] = loaded.issues;
    throw new VetError(
      issue?.code ?? CEV_ERROR_CODES.CRITERIA_INVALID,
      issue === undefined
        ? `invalid criteria file: ${file}`
        : `${file}${issue.path}: ${issue.message}`,
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
      `lint criteria.yaml against Jev wording weak spots (default: ${DEFAULT_CRITERIA_PATH})`,
    )
    .action(async (path: string | undefined, _options: unknown, command: Command) => {
      await lintCommand(path ?? DEFAULT_CRITERIA_PATH, command.optsWithGlobals<GlobalOptions>());
    });
}
