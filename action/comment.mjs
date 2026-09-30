// The vetkit action's PR comment. Reads the `vet run --json`
// document and, when present, the base branch's one, renders ONE markdown comment identified by
// a hidden marker and upserts it through `gh api` (no npm dependencies). Only case ids, outcomes,
// counts, the model, gate reasons and an error's code and message are rendered: never verdict
// payloads or judge requests, and any secret-looking env value is redacted as a second line of
// defence.
//
//   node comment.mjs comment <run.json> <baseline.json> [raw.json]   upsert the PR comment
//     (raw.json is vet's stdout: an error in it, such as a rejected key, is this run's outcome)
//   env: COMMENT_ID (marker suffix), REPORT_MD (path of the Markdown report to embed),
//        ARTIFACT_URL (report artifact link)
//   node comment.mjs outputs <run.json>                   print passed=/failed=/unscored=/hasResult=
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const MARKER = '<!-- vetkit-report -->';
const COMMENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
// GitHub rejects comment bodies over 65,536 characters.
const MAX_BODY = 65_536;
// Keeps the comment short enough to scan in a PR.
const MAX_ROWS = 20;
const MAX_ID = 100;
const MAX_MESSAGE = 300;
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i;
const CHANGE_ORDER = ['new-fail', 'unscored', 'new-pass', 'still-failing'];
// Error codes of the CLI (packages/cli/src/errors.ts) with the `E_` prefix stripped: the judge
// rejected the key, and the judge could not answer (down, timed out, throttled, out of credit).
const AUTH_CODES = new Set(['JUDGE_UNAUTHORIZED', 'AUTH']);
const JUDGE_DOWN_CODES = new Set([
  'JUDGE_UNAVAILABLE',
  'JUDGE_TIMEOUT',
  'UNSCORED_ONLY',
  'NETWORK',
  'TIMEOUT',
  'RATE_LIMIT',
]);
const NO_RESULT = 'vet run produced no result: no run record and no readable `--json` output.';

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

function cell(text, max = MAX_ID) {
  const clipped = text.length > max ? `${text.slice(0, max)}…` : text;
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

function annotate(message) {
  console.log(`::warning::${message}`);
}

/** The hidden marker; COMMENT_ID keeps several vetkit comments on one PR apart. */
export function markerFor(id, warn = annotate) {
  if (id === undefined || id === '') return MARKER;
  if (!COMMENT_ID.test(id)) {
    warn('vetkit: COMMENT_ID must match [A-Za-z0-9_-]{1,64}; using the default comment marker');
    return MARKER;
  }
  return `<!-- vetkit-report:${id} -->`;
}

function errorCode(doc) {
  const code = doc?.error?.code;
  return typeof code === 'string' && code !== '' ? code : 'UNKNOWN';
}

// Error before gate before unscored before failed: the first line says why the run is not green.
// `passed` needs a run result with exit code 0 and no failed verdict; anything else is not green.
function headline(doc) {
  if (doc?.error !== undefined) {
    const code = errorCode(doc).replace(/^E_/, '');
    // The kind `terminal-auth` is a rejected credential under any code.
    if (AUTH_CODES.has(code) || doc.error?.kind === 'terminal-auth') {
      return '### vetkit: auth error (the judge rejected the key named by the config)';
    }
    if (JUDGE_DOWN_CODES.has(code)) return '### vetkit: unscored (judge unavailable)';
    return '### vetkit: failed';
  }
  const { passed, failed, unscored } = runOutputs(doc);
  if ((doc?.gateReasons ?? []).length > 0) return '### vetkit: gate refused';
  if (doc?.exitCode === 3 || (unscored > 0 && passed === 0 && failed === 0)) {
    return '### vetkit: unscored (judge unavailable)';
  }
  if (doc?.summary !== undefined && doc.exitCode === 0 && failed === 0) {
    return '### vetkit: passed';
  }
  return '### vetkit: failed';
}

// The code, the judge failure kind when there is one, and the message on one line. The message
// sits in a code span so markup in it stays inert.
function errorLine(doc) {
  const { kind, message } = typeof doc.error === 'object' && doc.error !== null ? doc.error : {};
  const parts = [`Error \`${cell(errorCode(doc))}\``];
  if (typeof kind === 'string' && kind !== '') parts.push(` (${cell(kind)})`);
  if (typeof message === 'string' && message.trim() !== '') {
    parts.push(`: \`${cell(message.trim(), MAX_MESSAGE)}\``);
  }
  return parts.join('');
}

function banners(doc) {
  const lines = [];
  const results = doc?.results;
  if (Array.isArray(results) && !results.some((v) => v.calibrated === true)) {
    lines.push('thresholds uncalibrated: run vet validate');
  }
  if (doc?.model?.pinned === false) {
    lines.push(
      'pinned: false — the judge alias may serve a different model between runs, so scores can drift.',
    );
  }
  return lines;
}

function links(env) {
  const lines = [];
  const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: run } = env;
  if (server && repo && run) lines.push(`[Workflow run](${server}/${repo}/actions/runs/${run})`);
  if ((env.ARTIFACT_URL ?? '').startsWith('https://')) {
    lines.push(`[Report artifact](${env.ARTIFACT_URL})`);
  }
  return lines.join(' · ');
}

function statusLines(doc, env) {
  const lines = [headline(doc)];
  if (doc?.error !== undefined) lines.push('', errorLine(doc));
  else if (doc?.summary === undefined) lines.push('', NO_RESULT);
  const model = doc?.model;
  if (model !== undefined) {
    const name = model.resolved ? model.resolved : (model.requested ?? 'unknown');
    lines.push(
      '',
      `Model: \`${cell(String(name))}\` (transport ${cell(String(model.transport ?? '?'))})`,
    );
  }
  for (const reason of doc?.gateReasons ?? [])
    lines.push('', `Gate refused: ${cell(String(reason))}`);
  const notes = banners(doc);
  if (notes.length > 0)
    lines.push('', ...notes.flatMap((note, i) => (i === 0 ? [note] : ['', note])));
  const linkLine = links(env);
  if (linkLine !== '') lines.push('', linkLine);
  return lines;
}

/**
 * The comment body: marker, one-line outcome, banners, links, then the Markdown report when one
 * exists, otherwise the counts and the delta table.
 */
export function renderComment({ current, baseline, env = process.env, reportMd, warn }) {
  const redact = redactor(env);
  const marker = markerFor(env.COMMENT_ID, warn);
  const status = statusLines(current, env);
  // A report on disk belongs to a run that produced a result: never to an error or to no result.
  const hasResult = current?.error === undefined && current?.summary !== undefined;
  if (hasResult && typeof reportMd === 'string' && reportMd.trim() !== '') {
    const head = [marker, ...status, '', ''].join('\n');
    const note = '\n\n_report truncated; see the artifact_';
    const room = MAX_BODY - head.length;
    const report =
      reportMd.length <= room
        ? reportMd
        : `${reportMd.slice(0, Math.max(0, room - note.length))}${note}`;
    return redact(`${head}${report}`).slice(0, MAX_BODY);
  }
  const { passed, failed, unscored } = runOutputs(current);
  const summary = current?.summary ?? {};
  const header = [marker, ...status];
  if (summary.total !== undefined) {
    header.push(
      '',
      `**${String(passed)} passed · ${String(failed)} failed · ${String(unscored)} unscored** of ${String(summary.total)}${summary.aborted ? ' (aborted)' : ''} · exit ${String(current?.exitCode ?? '?')}`,
    );
  }
  if (!hasResult) return redact(build(header, undefined, 0, 0));

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

/** Finds the comment carrying the marker and updates it, or creates one. Never throws on gh errors. */
export async function upsertComment({
  gh,
  repo,
  issueNumber,
  body,
  marker = MARKER,
  warn = console.warn,
}) {
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
    `.[] | select(.body | contains("${marker}")) | .id`,
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

function readText(path) {
  if (path === undefined || path === '') return undefined;
  try {
    return readFileSync(path, 'utf8');
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
    // gh may exit without reading stdin: the result then comes from its exit code and stdout.
    child.stdin.on('error', (error) => {
      if (error.code !== 'EPIPE') resolve({ code: 1, stdout, stderr: error.message });
    });
    child.stdin.end(stdin ?? '');
  });
}

export async function main({ env = process.env, argv, gh = runGh, warn = console.warn }) {
  const [mode, runPath, basePath, rawPath] = argv;
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
  if (issueNumber === undefined || env.GITHUB_REPOSITORY === undefined) {
    warn('vetkit: no pull request number or repository; skipping the PR comment');
    return 'skipped';
  }
  // An error in the raw vet output is this run's outcome: a run record next to it is from an
  // earlier run. With neither a record nor a readable raw output the comment says so.
  const raw = readJson(rawPath);
  const doc = raw?.error === undefined ? (current ?? raw) : raw;
  const marker = markerFor(env.COMMENT_ID, warn);
  const body = renderComment({
    current: doc,
    baseline: readJson(basePath),
    env: { ...env, COMMENT_ID: marker === MARKER ? undefined : env.COMMENT_ID },
    reportMd: readText(env.REPORT_MD),
    warn,
  });
  return upsertComment({ gh, repo: env.GITHUB_REPOSITORY, issueNumber, body, marker, warn });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const result = await main({ argv: process.argv.slice(2), warn: annotate });
  if (process.argv[2] === 'outputs') console.log(result);
}
