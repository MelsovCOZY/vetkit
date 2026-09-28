// The vetkit action's PR comment (UX brief §3 item 8; DECISION C10). Reads the `vet run --json`
// document and, when present, the base branch's one, renders ONE markdown comment identified by
// a hidden marker and upserts it through `gh api` (no npm dependencies). Only case ids, outcomes,
// counts, the model and gate reasons are rendered: never verdict payloads or judge requests,
// and any secret-looking env value is redacted as a second line of defence.
//
//   node comment.mjs comment <run.json> <baseline.json>   upsert the PR comment
//   node comment.mjs outputs <run.json>                   print passed=/failed=/unscored=/hasResult=
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const MARKER = '<!-- vetkit-report -->';
// GitHub rejects comment bodies over 65,536 characters.
const MAX_BODY = 65_536;
// Keeps the comment under ~40 lines (bead rubric).
const MAX_ROWS = 20;
const MAX_ID = 100;
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i;
const CHANGE_ORDER = ['new-fail', 'unscored', 'new-pass', 'still-failing'];

// Same precedence as the CLI and core summary: any failed verdict fails the case, then any
// unscored one; not_applicable verdicts do not count.
function outcome(verdicts) {
  const counted = verdicts.filter((v) => v.status !== 'not_applicable');
  if (counted.some((v) => v.status === 'ok' && v.pass !== true)) return 'fail';
  if (counted.some((v) => v.status !== 'ok')) return 'unscored';
  return 'pass';
}

function caseOutcomes(doc) {
  const byCase = new Map();
  for (const v of doc?.results ?? []) {
    const id = String(v.caseId);
    byCase.set(id, [...(byCase.get(id) ?? []), v]);
  }
  return new Map([...byCase].map(([id, verdicts]) => [id, outcome(verdicts)]));
}

/** Per-case changes versus the baseline; unchanged passing cases are left out. */
export function computeDeltas(current, baseline) {
  const now = caseOutcomes(current);
  const before = caseOutcomes(baseline);
  const rows = [];
  for (const [caseId, result] of now) {
    const base = before.get(caseId) ?? 'absent';
    let change;
    if (result === 'unscored') change = 'unscored';
    else if (result === 'fail') change = base === 'fail' ? 'still-failing' : 'new-fail';
    else if (base !== 'pass') change = 'new-pass';
    if (change !== undefined) rows.push({ caseId, change, base, now: result });
  }
  return rows.toSorted((a, b) => CHANGE_ORDER.indexOf(a.change) - CHANGE_ORDER.indexOf(b.change));
}

export function runOutputs(doc) {
  const summary = doc?.summary ?? {};
  return {
    passed: Number(summary.passed ?? 0),
    failed: Number(summary.failed ?? 0),
    unscored: Number(summary.unscored ?? 0),
  };
}

function redactor(env) {
  const secrets = Object.entries(env)
    .filter(([name, value]) => SECRET_NAME.test(name) && typeof value === 'string')
    .map(([, value]) => value)
    .filter((value) => value.length >= 8)
    .toSorted((a, b) => b.length - a.length);
  return (text) => secrets.reduce((out, secret) => out.replaceAll(secret, '[redacted]'), text);
}

function cell(text) {
  const clipped = text.length > MAX_ID ? `${text.slice(0, MAX_ID)}…` : text;
  return clipped.replaceAll('|', '\\|').replaceAll('`', "'").replaceAll(/\s+/g, ' ');
}

function build(header, rows, total, unchanged) {
  const lines = [...header];
  if (rows !== undefined) {
    lines.push('', '| Case | Change | Base | Now |', '| --- | --- | --- | --- |');
    for (const r of rows) {
      lines.push(`| \`${cell(r.caseId)}\` | ${r.change} | ${r.base} | ${r.now} |`);
    }
    const hidden = total - rows.length;
    if (hidden > 0) lines.push('', `_${String(hidden)} more cases not shown._`);
    if (unchanged > 0) lines.push('', `${String(unchanged)} passing cases unchanged.`);
  }
  return lines.join('\n');
}

/** The comment body: marker, counts, model, gate reasons and the delta table. */
export function renderComment({ current, baseline, env = process.env }) {
  const redact = redactor(env);
  const { passed, failed, unscored } = runOutputs(current);
  const summary = current?.summary ?? {};
  const model = current?.model ?? {};
  const name = model.resolved ? model.resolved : (model.requested ?? 'unknown');
  const header = [
    MARKER,
    '### vetkit eval report',
    '',
    `**${String(passed)} passed · ${String(failed)} failed · ${String(unscored)} unscored** of ${String(summary.total ?? 0)}${summary.aborted ? ' (aborted)' : ''} · exit ${String(current?.exitCode ?? '?')}`,
    '',
    `Model: \`${cell(String(name))}\` (transport ${cell(String(model.transport ?? '?'))}, pinned: ${String(model.pinned === true)})`,
  ];
  for (const reason of current?.gateReasons ?? [])
    header.push('', `Gate refused: ${cell(String(reason))}`);

  if (baseline === undefined) {
    header.push('', '_No baseline: no `.vet/runs/latest.json` from the base branch in the cache._');
    return redact(build(header, undefined, 0, 0));
  }
  const rows = computeDeltas(current, baseline);
  const unchanged = caseOutcomes(current).size - rows.length;
  header.push(
    '',
    rows.length === 0 ? 'No changes versus the base branch.' : 'Changes versus the base branch:',
  );
  if (rows.length === 0) return redact(build(header, undefined, 0, 0));
  let shown = rows.slice(0, MAX_ROWS);
  let body = redact(build(header, shown, rows.length, unchanged));
  while (body.length > MAX_BODY && shown.length > 0) {
    shown = shown.slice(0, Math.floor(shown.length / 2));
    body = redact(build(header, shown, rows.length, unchanged));
  }
  return body.slice(0, MAX_BODY);
}

function firstLine(text) {
  return String(text).trim().split('\n')[0] ?? '';
}

/** Finds the comment carrying MARKER and updates it, or creates one. Never throws on gh errors. */
export async function upsertComment({ gh, repo, issueNumber, body, warn = console.warn }) {
  const cannot = (stderr) => {
    warn(
      `vetkit: could not post the PR comment (the token needs \`pull-requests: write\`; fork PRs get a read-only token): ${firstLine(stderr)}`,
    );
    return 'skipped';
  };
  const list = await gh([
    'api',
    '--paginate',
    `repos/${repo}/issues/${String(issueNumber)}/comments`,
    '--jq',
    `.[] | select(.body | contains("${MARKER}")) | .id`,
  ]);
  if (list.code !== 0) return cannot(list.stderr);
  const id = list.stdout.split('\n').find((line) => line.trim() !== '');
  const payload = JSON.stringify({ body });
  const write =
    id === undefined
      ? await gh(
          [
            'api',
            '-X',
            'POST',
            `repos/${repo}/issues/${String(issueNumber)}/comments`,
            '--input',
            '-',
          ],
          payload,
        )
      : await gh(
          ['api', '-X', 'PATCH', `repos/${repo}/issues/comments/${id.trim()}`, '--input', '-'],
          payload,
        );
  if (write.code !== 0) return cannot(write.stderr);
  return id === undefined ? 'created' : 'updated';
}

function readJson(path) {
  if (path === undefined) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

function runGh(args, stdin) {
  return new Promise((resolve) => {
    const child = spawn('gh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', (error) => resolve({ code: 127, stdout, stderr: error.message }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(stdin ?? '');
  });
}

export async function main({ env = process.env, argv, gh = runGh, warn = console.warn }) {
  const [mode, runPath, basePath] = argv;
  const current = readJson(runPath);
  if (mode === 'outputs') {
    // hasResult: the document is a run result (a --json error document is not a baseline).
    const outputs = { ...runOutputs(current), hasResult: current?.summary !== undefined };
    return Object.entries(outputs)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join('\n');
  }
  const event = env.GITHUB_EVENT_NAME;
  if (event !== 'pull_request' && event !== 'pull_request_target') return 'skipped';
  const issueNumber = readJson(env.GITHUB_EVENT_PATH)?.pull_request?.number;
  if (current === undefined || issueNumber === undefined || env.GITHUB_REPOSITORY === undefined) {
    warn('vetkit: no run result or pull request number; skipping the PR comment');
    return 'skipped';
  }
  const body = renderComment({ current, baseline: readJson(basePath), env });
  return upsertComment({ gh, repo: env.GITHUB_REPOSITORY, issueNumber, body, warn });
}

function annotate(message) {
  console.log(`::warning::${message}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const result = await main({ argv: process.argv.slice(2), warn: annotate });
  if (process.argv[2] === 'outputs') console.log(result);
}
