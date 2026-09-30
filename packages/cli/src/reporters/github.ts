// GitHub Actions reporter for `vet run`: workflow-command annotations plus the job summary.
// Both are switched on by the runner's GITHUB_ACTIONS=true (no flag). Annotations go to stderr
// so `--json` stdout stays one document. Every text is redacted first and escaped second, since
// escaped text no longer matches a raw secret.
import { appendFile } from 'node:fs/promises';
import type { RunEvalsResult } from '@vetkit/core';
import { getLogger } from '../output.ts';
import { redact } from '../redact.ts';
import { failureMessage } from './junit.ts';

type Env = Record<string, string | undefined>;

/** GitHub shows at most 10 annotations per type per step; extras are dropped. */
const MAX_PER_TYPE = 10;
/** GITHUB_STEP_SUMMARY accepts at most 1 MiB per step. */
const MAX_SUMMARY_BYTES = 1024 * 1024;
const TRUNCATED_MARKER = '\n_truncated_\n';

export interface AnnotationInput {
  readonly results: RunEvalsResult['results'];
  readonly summary: Pick<RunEvalsResult['summary'], 'aborted'>;
}

// Workflow-command message escaping: `%`, CR and LF.
function escapeData(text: string): string {
  return text.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

function command(level: 'error' | 'warning' | 'notice', message: string, env: Env): string {
  return `::${level} title=vetkit::${escapeData(redact(message, env))}`;
}

/** Pure. One `::error` per scored fail, one `::warning` per other non-ok verdict, capped. */
export function renderAnnotations(
  result: AnnotationInput,
  options: { readonly env: Env },
): string[] {
  const { env } = options;
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const v of result.results) {
    if (v.status === 'ok') {
      if (v.pass !== true) {
        errors.push(`${v.caseId} failed: ${v.criterionId} (${failureMessage(v)})`);
      }
    } else if (v.status !== 'not_applicable') {
      warnings.push(`${v.caseId} ${v.status}: ${v.criterionId}`);
    }
  }
  const lines = [
    ...errors.slice(0, MAX_PER_TYPE).map((m) => command('error', m, env)),
    ...warnings.slice(0, MAX_PER_TYPE).map((m) => command('warning', m, env)),
  ];
  const moreErrors = Math.max(0, errors.length - MAX_PER_TYPE);
  const moreWarnings = Math.max(0, warnings.length - MAX_PER_TYPE);
  if (moreErrors + moreWarnings > 0) {
    lines.push(
      command(
        'notice',
        `${String(moreErrors)} more error(s) and ${String(moreWarnings)} more warning(s) not annotated`,
        env,
      ),
    );
  }
  if (result.summary.aborted) lines.push(command('warning', 'run aborted', env));
  return lines;
}

export interface GithubSummaryInput {
  readonly markdown: string;
  readonly env: Env;
  readonly fs?: { readonly appendFile: (path: string, data: string) => Promise<void> };
}

function capBytes(markdown: string): string {
  const bytes = Buffer.from(markdown, 'utf8');
  if (bytes.length <= MAX_SUMMARY_BYTES) return markdown;
  const room = MAX_SUMMARY_BYTES - Buffer.byteLength(TRUNCATED_MARKER) - 4;
  // Slicing may cut a multi-byte character; drop the replacement character it decodes to.
  const head = bytes.subarray(0, room).toString('utf8').replace(/�+$/, '');
  return head + TRUNCATED_MARKER;
}

/** Appends the Markdown to the job summary; a no-op without GITHUB_STEP_SUMMARY, never throws. */
export async function writeGithubSummary(input: GithubSummaryInput): Promise<void> {
  const path = input.env['GITHUB_STEP_SUMMARY'];
  if (path === undefined || path === '') return;
  const append = input.fs?.appendFile ?? ((p: string, data: string) => appendFile(p, data));
  try {
    await append(path, capBytes(input.markdown));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    getLogger().warn(`cannot write GITHUB_STEP_SUMMARY: ${redact(reason, input.env)}`);
  }
}

/** Annotations to stderr, then the summary. `markdown` is the shared report renderer's output. */
export async function reportToGithub(input: {
  readonly result: AnnotationInput;
  readonly markdown: string;
  readonly env: Env;
}): Promise<void> {
  const lines = renderAnnotations(input.result, { env: input.env });
  if (lines.length > 0) process.stderr.write(`${lines.join('\n')}\n`);
  await writeGithubSummary({ markdown: input.markdown, env: input.env });
}
