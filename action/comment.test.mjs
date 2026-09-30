// Plain Node test runner: `node --test action/comment.test.mjs`. No network: `gh` is a stub.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  MARKER,
  computeDeltas,
  main,
  renderComment,
  runOutputs,
  upsertComment,
} from './comment.mjs';
import * as commentModule from './comment.mjs';

const markerFor = (...args) => commentModule.markerFor(...args);

const FAKE_KEY = 'sk-fake-0123456789abcdef-SEEDED';

function verdict(caseId, criterionId, outcome) {
  if (outcome === 'unscored') return { caseId, criterionId, status: 'judge_error' };
  return { caseId, criterionId, status: 'ok', pass: outcome === 'pass' };
}

function runDoc(verdicts, extra = {}) {
  return {
    results: verdicts,
    summary: {
      total: verdicts.length,
      passed: verdicts.filter((v) => v.status === 'ok' && v.pass === true).length,
      failed: verdicts.filter((v) => v.status === 'ok' && v.pass !== true).length,
      unscored: verdicts.filter((v) => v.status !== 'ok').length,
      aborted: false,
      byCriterion: {},
    },
    model: {
      requested: 'typesafe-ai/jev',
      resolved: 'typesafe-ai/jev-served-1',
      transport: 'gateway',
      pinned: false,
    },
    exitCode: 1,
    gateReasons: [],
    ...extra,
  };
}

const baseline = runDoc([
  verdict('case-a', 'tone', 'pass'),
  verdict('case-b', 'tone', 'fail'),
  verdict('case-c', 'tone', 'fail'),
  verdict('case-d', 'tone', 'pass'),
]);

const current = runDoc([
  verdict('case-a', 'tone', 'fail'),
  verdict('case-b', 'tone', 'pass'),
  verdict('case-c', 'tone', 'fail'),
  verdict('case-d', 'tone', 'unscored'),
  verdict('case-e', 'tone', 'fail'),
]);

void test('computeDeltas classifies each case by id against the baseline', () => {
  const changes = Object.fromEntries(computeDeltas(current, baseline).map((r) => [r.caseId, r]));
  assert.equal(changes['case-a']?.change, 'new-fail');
  assert.equal(changes['case-b']?.change, 'new-pass');
  assert.equal(changes['case-c']?.change, 'still-failing');
  assert.equal(changes['case-d']?.change, 'unscored');
  assert.equal(changes['case-e']?.change, 'new-fail');
  assert.equal(changes['case-e']?.base, 'absent');
});

void test('computeDeltas leaves unchanged passing cases out', () => {
  const same = runDoc([verdict('case-a', 'tone', 'pass')]);
  assert.deepEqual(computeDeltas(same, same), []);
});

void test('a case with any failed verdict fails even when another is unscored', () => {
  const doc = runDoc([verdict('case-x', 'tone', 'unscored'), verdict('case-x', 'len', 'fail')]);
  const [row] = computeDeltas(doc, runDoc([]));
  assert.equal(row?.change, 'new-fail');
});

void test('renderComment starts with the hidden marker and shows counts, model and pinned flag', () => {
  const body = renderComment({ current, baseline, env: {} });
  assert.ok(body.startsWith(MARKER));
  assert.equal(MARKER, '<!-- vetkit-report -->');
  assert.match(body, /1 passed/);
  assert.match(body, /3 failed/);
  assert.match(body, /1 unscored/);
  assert.match(body, /typesafe-ai\/jev-served-1/);
  assert.match(body, /pinned: false/);
});

void test('renderComment renders the delta table against the baseline', () => {
  const body = renderComment({ current, baseline, env: {} });
  assert.match(body, /\| Case \| Change \| Base \| Now \|/);
  assert.match(body, /\| `case-a` \| new-fail \| pass \| fail \|/);
  assert.match(body, /\| `case-b` \| new-pass \| fail \| pass \|/);
  assert.match(body, /\| `case-c` \| still-failing \| fail \| fail \|/);
  assert.match(body, /\| `case-d` \| unscored \| pass \| unscored \|/);
  assert.doesNotMatch(body, /no baseline/i);
});

void test('renderComment says no baseline when none was restored', () => {
  const body = renderComment({ current, baseline: undefined, env: {} });
  assert.match(body, /no baseline/i);
  assert.doesNotMatch(body, /\| Case \| Change \|/);
});

void test('renderComment never contains a seeded key value or judge request bodies', () => {
  const leaky = runDoc(
    [
      {
        ...verdict(`case-${FAKE_KEY}`, 'tone', 'fail'),
        request: { state: `Authorization: Bearer ${FAKE_KEY}` },
        rationale: `echoed ${FAKE_KEY}`,
      },
    ],
    { gateReasons: [`transport error with ${FAKE_KEY}`] },
  );
  const body = renderComment({
    current: leaky,
    baseline: undefined,
    env: { AI_GATEWAY_API_KEY: FAKE_KEY, HOME: '/home/runner' },
  });
  assert.ok(!body.includes(FAKE_KEY), 'seeded key leaked into the comment');
  assert.ok(!body.includes('Authorization'), 'judge request body leaked into the comment');
});

void test('renderComment truncates the table with a note when the body would exceed the limit', () => {
  const many = runDoc(
    Array.from({ length: 5000 }, (_, i) =>
      verdict(`case-${String(i)}-${'x'.repeat(20)}`, 't', 'fail'),
    ),
  );
  const body = renderComment({ current: many, baseline: runDoc([]), env: {} });
  assert.ok(body.length <= 65_536, `body is ${String(body.length)} chars`);
  assert.match(body, /more cases? not shown/);
  assert.ok(body.startsWith(MARKER));
});

void test('renderComment keeps a large table under 40 lines', () => {
  const many = runDoc(Array.from({ length: 100 }, (_, i) => verdict(`c${String(i)}`, 't', 'fail')));
  const body = renderComment({ current: many, baseline: runDoc([]), env: {} });
  assert.ok(body.split('\n').length <= 40, `${String(body.split('\n').length)} lines`);
  assert.match(body, /more cases? not shown/);
});

void test('runOutputs exposes the summary counts', () => {
  assert.deepEqual(runOutputs(current), { passed: 1, failed: 3, unscored: 1 });
});

function ghStub(responses) {
  const calls = [];
  const gh = async (args, stdin) => {
    calls.push({ args, stdin });
    const next = responses.shift() ?? { code: 0, stdout: '', stderr: '' };
    return next;
  };
  return { gh, calls };
}

void test('upsertComment updates the existing marked comment', async () => {
  const { gh, calls } = ghStub([{ code: 0, stdout: '42\n', stderr: '' }]);
  const result = await upsertComment({ gh, repo: 'o/r', issueNumber: 7, body: `${MARKER}\nhi` });
  assert.equal(result, 'updated');
  assert.equal(calls.length, 2);
  assert.ok(calls[0]?.args.includes('repos/o/r/issues/7/comments'));
  assert.ok(calls[1]?.args.includes('repos/o/r/issues/comments/42'));
  assert.ok(calls[1]?.args.includes('PATCH'));
  assert.match(calls[1]?.stdin ?? '', /vetkit-report/);
});

void test('upsertComment creates a comment when none carries the marker', async () => {
  const { gh, calls } = ghStub([{ code: 0, stdout: '', stderr: '' }]);
  const result = await upsertComment({ gh, repo: 'o/r', issueNumber: 7, body: `${MARKER}\nhi` });
  assert.equal(result, 'created');
  assert.ok(calls[1]?.args.includes('POST'));
  assert.ok(calls[1]?.args.includes('repos/o/r/issues/7/comments'));
});

void test('upsertComment warns and continues when the token cannot write', async () => {
  const warnings = [];
  const { gh } = ghStub([
    { code: 0, stdout: '', stderr: '' },
    { code: 1, stdout: '', stderr: 'HTTP 403: Resource not accessible by integration' },
  ]);
  const result = await upsertComment({
    gh,
    repo: 'o/r',
    issueNumber: 7,
    body: MARKER,
    warn: (m) => warnings.push(m),
  });
  assert.equal(result, 'skipped');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /pull-requests: write/);
});

function workspace(files) {
  const dir = mkdtempSync(join(tmpdir(), 'vetkit-action-'));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

void test('main skips silently outside a pull_request event', async () => {
  const dir = workspace({ 'run.json': JSON.stringify(current) });
  const { gh, calls } = ghStub([]);
  const warnings = [];
  const result = await main({
    env: { GITHUB_EVENT_NAME: 'push', GITHUB_REPOSITORY: 'o/r' },
    argv: ['comment', join(dir, 'run.json'), join(dir, 'missing.json')],
    gh,
    warn: (m) => warnings.push(m),
  });
  assert.equal(result, 'skipped');
  assert.equal(calls.length, 0);
  assert.deepEqual(warnings, []);
});

void test('main posts on a pull_request event with the baseline file', async () => {
  const dir = workspace({
    'run.json': JSON.stringify(current),
    'base.json': JSON.stringify(baseline),
    'event.json': JSON.stringify({ pull_request: { number: 9 } }),
  });
  const { gh, calls } = ghStub([{ code: 0, stdout: '', stderr: '' }]);
  const result = await main({
    env: {
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_REPOSITORY: 'o/r',
      GITHUB_EVENT_PATH: join(dir, 'event.json'),
    },
    argv: ['comment', join(dir, 'run.json'), join(dir, 'base.json')],
    gh,
    warn: () => {},
  });
  assert.equal(result, 'created');
  assert.ok(calls[1]?.args.includes('repos/o/r/issues/9/comments'));
  assert.match(calls[1]?.stdin ?? '', /still-failing/);
});

void test('runGh survives a gh that exits without reading stdin', () => {
  const dir = workspace({
    'run.json': JSON.stringify(current),
    'event.json': JSON.stringify({ pull_request: { number: 9 } }),
    // Quotes double in JSON, so the POST payload outgrows the pipe buffer and cannot be written at once.
    'report.md': '"'.repeat(60_000),
  });
  const bin = join(dir, 'gh');
  const log = join(dir, 'gh.log');
  // Records its arguments, closes stdin at once and exits 0 without reading it: the parent's write hits a closed pipe.
  writeFileSync(bin, `#!/bin/sh\necho "$@" >> '${log}'\nexec 0<&-\nexit 0\n`);
  chmodSync(bin, 0o755);
  // A child process: an unhandled EPIPE crashes the process, which in-process would only fail asynchronously.
  const child = spawnSync(
    process.execPath,
    [
      join(import.meta.dirname, 'comment.mjs'),
      'comment',
      join(dir, 'run.json'),
      join(dir, 'missing.json'),
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_REPOSITORY: 'o/r',
        GITHUB_EVENT_PATH: join(dir, 'event.json'),
        REPORT_MD: join(dir, 'report.md'),
      },
    },
  );
  assert.doesNotMatch(child.stderr, /EPIPE/);
  assert.equal(child.status, 0, child.stderr);
  const calls = readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(calls.length, 2, 'the list and then the POST reach the stub');
  assert.match(calls[1] ?? '', /-X POST repos\/o\/r\/issues\/9\/comments/);
});

const HEADLINE = {
  failed: '### vetkit: failed',
  unscored: '### vetkit: unscored (judge unavailable)',
  auth: '### vetkit: auth error (the judge rejected the key named by the config)',
  gate: '### vetkit: gate refused',
  passed: '### vetkit: passed',
};

/** The line right after the marker. */
function headlineOf(body) {
  return body.split('\n')[1];
}

const passingDoc = () => runDoc([verdict('case-a', 'tone', 'pass')], { exitCode: 0 });

void test("renderComment headline is '### vetkit: failed' for exitCode 1", () => {
  const body = renderComment({ current, baseline: undefined, env: {} });
  assert.equal(headlineOf(body), HEADLINE.failed);
});

void test("renderComment headline is '### vetkit: unscored (judge unavailable)' for exitCode 3 and for an all-unscored summary", () => {
  const unscoredOnly = [
    verdict('case-a', 'tone', 'unscored'),
    verdict('case-b', 'tone', 'unscored'),
  ];
  const byExit = renderComment({
    current: runDoc(unscoredOnly, { exitCode: 3 }),
    baseline: undefined,
    env: {},
  });
  assert.equal(headlineOf(byExit), HEADLINE.unscored);
  const byCounts = renderComment({
    current: runDoc(unscoredOnly, { exitCode: 1 }),
    baseline: undefined,
    env: {},
  });
  assert.equal(headlineOf(byCounts), HEADLINE.unscored);
});

void test("renderComment headline is '### vetkit: auth error (the judge rejected the key named by the config)' for an {error:{code:'JUDGE_UNAUTHORIZED'}} document", () => {
  const body = renderComment({
    current: { error: { code: 'JUDGE_UNAUTHORIZED', message: 'HTTP 401' } },
    baseline: runDoc([verdict('case-a', 'tone', 'pass')]),
    env: {},
  });
  assert.equal(headlineOf(body), HEADLINE.auth);
  assert.doesNotMatch(body, /\| Case \| Change \|/);
});

void test("renderComment headline is '### vetkit: gate refused' for exitCode 2 with gateReasons", () => {
  const body = renderComment({
    current: runDoc([verdict('case-a', 'tone', 'pass')], {
      exitCode: 2,
      gateReasons: ['no criteria.lock.json'],
    }),
    baseline: undefined,
    env: {},
  });
  assert.equal(headlineOf(body), HEADLINE.gate);
  assert.match(body, /no criteria\.lock\.json/);
});

void test("renderComment headline is '### vetkit: passed' for exitCode 0", () => {
  const body = renderComment({ current: passingDoc(), baseline: undefined, env: {} });
  assert.equal(headlineOf(body), HEADLINE.passed);
});

void test("renderComment shows 'thresholds uncalibrated: run vet validate' when no verdict is calibrated and omits it when one is", () => {
  const uncalibrated = renderComment({ current: passingDoc(), baseline: undefined, env: {} });
  assert.match(uncalibrated, /thresholds uncalibrated: run vet validate/);
  const calibrated = renderComment({
    current: runDoc([{ ...verdict('case-a', 'tone', 'pass'), calibrated: true }], { exitCode: 0 }),
    baseline: undefined,
    env: {},
  });
  assert.doesNotMatch(calibrated, /thresholds uncalibrated/);
});

void test("renderComment explains pinned: false in one line starting 'pinned: false —' and omits it when pinned is true", () => {
  const unpinned = renderComment({ current: passingDoc(), baseline: undefined, env: {} });
  const lines = unpinned.split('\n').filter((line) => line.startsWith('pinned: false —'));
  assert.equal(lines.length, 1);
  const pinnedDoc = passingDoc();
  pinnedDoc.model.pinned = true;
  const pinned = renderComment({ current: pinnedDoc, baseline: undefined, env: {} });
  assert.doesNotMatch(pinned, /pinned: false/);
});

void test('renderComment embeds the REPORT_MD file when present and the legacy counts header when absent', () => {
  const reportMd = '## Report body\n\nsee the tables below';
  const withReport = renderComment({ current, baseline, env: {}, reportMd });
  assert.match(withReport, /## Report body/);
  assert.doesNotMatch(withReport, /\| Case \| Change \|/);
  assert.ok(withReport.startsWith(MARKER));
  const legacy = renderComment({ current, baseline, env: {} });
  assert.match(legacy, /\*\*1 passed · 3 failed · 1 unscored\*\*/);
  assert.match(legacy, /\| Case \| Change \|/);
});

void test('renderComment truncates an oversized REPORT_MD and keeps the headline and links', () => {
  const body = renderComment({
    current,
    baseline: undefined,
    env: { GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '5' },
    reportMd: 'x'.repeat(100_000),
  });
  assert.ok(body.length <= 65_536);
  assert.match(body, /_report truncated; see the artifact_/);
  assert.equal(headlineOf(body), HEADLINE.failed);
  assert.match(body, /actions\/runs\/5/);
});

void test('renderComment links the run URL and, when ARTIFACT_URL is set, the report artifact', () => {
  const env = {
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_REPOSITORY: 'o/r',
    GITHUB_RUN_ID: '123',
  };
  const without = renderComment({ current: passingDoc(), baseline: undefined, env });
  assert.ok(without.includes('https://github.com/o/r/actions/runs/123'));
  assert.doesNotMatch(without, /artifacts\//);
  const artifact = 'https://github.com/o/r/actions/runs/123/artifacts/77';
  const withArtifact = renderComment({
    current: passingDoc(),
    baseline: undefined,
    env: { ...env, ARTIFACT_URL: artifact },
  });
  assert.ok(withArtifact.includes('https://github.com/o/r/actions/runs/123'));
  assert.ok(withArtifact.includes(artifact));
});

void test('renderComment never contains a seeded key value in the embedded REPORT_MD', () => {
  const body = renderComment({
    current: passingDoc(),
    baseline: undefined,
    env: { AI_GATEWAY_API_KEY: FAKE_KEY, HOME: '/home/runner' },
    reportMd: `## Report\n\nthe judge echoed ${FAKE_KEY}`,
  });
  assert.ok(!body.includes(FAKE_KEY), 'seeded key leaked through the report body');
  assert.match(body, /## Report/);
});

void test('MARKER is suffixed with COMMENT_ID and an invalid id falls back to the default marker with a ::warning', () => {
  const suffixed = renderComment({
    current: passingDoc(),
    baseline: undefined,
    env: { COMMENT_ID: 'evals-a' },
  });
  assert.ok(suffixed.startsWith('<!-- vetkit-report:evals-a -->'));
  assert.equal(markerFor(''), MARKER);
  assert.equal(markerFor(undefined), MARKER);
  const warnings = [];
  assert.equal(
    markerFor('bad id -->', (m) => warnings.push(m)),
    MARKER,
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /COMMENT_ID/);
  assert.equal(
    markerFor('a'.repeat(65), () => {}),
    MARKER,
  );
});

void test('upsertComment matches the suffixed marker', async () => {
  const marker = markerFor('evals-a');
  const { gh, calls } = ghStub([{ code: 0, stdout: '42\n', stderr: '' }]);
  const result = await upsertComment({
    gh,
    repo: 'o/r',
    issueNumber: 7,
    body: `${marker}\nhi`,
    marker,
  });
  assert.equal(result, 'updated');
  assert.ok(calls[0]?.args.some((arg) => arg.includes(marker)));
  assert.ok(!calls[0]?.args.some((arg) => arg.includes(`"${MARKER}"`)));
});

void test('main reads the raw output when no run result exists and posts the auth headline with the suffixed marker', async () => {
  const dir = workspace({
    'raw.json': JSON.stringify({ error: { code: 'JUDGE_UNAUTHORIZED' } }),
    'event.json': JSON.stringify({ pull_request: { number: 9 } }),
    'report.md': '## Report body',
  });
  const { gh, calls } = ghStub([{ code: 0, stdout: '', stderr: '' }]);
  const result = await main({
    env: {
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_REPOSITORY: 'o/r',
      GITHUB_EVENT_PATH: join(dir, 'event.json'),
      COMMENT_ID: 'evals-a',
      REPORT_MD: join(dir, 'report.md'),
      ARTIFACT_URL: 'https://github.com/o/r/actions/runs/1/artifacts/2',
    },
    argv: ['comment', join(dir, 'missing.json'), join(dir, 'missing.json'), join(dir, 'raw.json')],
    gh,
    warn: () => {},
  });
  assert.equal(result, 'created');
  const posted = JSON.parse(calls[1]?.stdin ?? '{}').body;
  assert.ok(posted.startsWith('<!-- vetkit-report:evals-a -->'));
  assert.equal(headlineOf(posted), HEADLINE.auth);
  assert.match(posted, /artifacts\/2/);
});

function errorDoc(code, extra = {}) {
  return { error: { code, message: `${code} happened`, hint: 'fix it, then retry.', ...extra } };
}

const headlineFor = (doc) =>
  headlineOf(renderComment({ current: doc, baseline: undefined, env: {} }));

void test("renderComment headline is '### vetkit: unscored (judge unavailable)' for a no-credit error document and the body names the code and the kind", () => {
  const body = renderComment({
    current: errorDoc('JUDGE_UNAVAILABLE', {
      message: 'judge account has no credit',
      kind: 'terminal-billing',
    }),
    baseline: undefined,
    env: {},
  });
  assert.equal(headlineOf(body), HEADLINE.unscored);
  assert.ok(body.includes('JUDGE_UNAVAILABLE'), 'the error code is shown');
  assert.ok(body.includes('terminal-billing'), 'the kind tells no credit from an outage');
  assert.ok(body.includes('judge account has no credit'), 'the message is shown');
});

void test("renderComment headline is '### vetkit: unscored (judge unavailable)' for every error that means the judge could not answer", () => {
  const docs = [
    errorDoc('JUDGE_UNAVAILABLE'),
    errorDoc('JUDGE_UNAVAILABLE', { kind: 'retryable' }),
    errorDoc('JUDGE_UNAVAILABLE', { kind: 'terminal-request' }),
    errorDoc('JUDGE_TIMEOUT'),
    errorDoc('UNSCORED_ONLY'),
    errorDoc('E_RATE_LIMIT'),
    errorDoc('E_TIMEOUT'),
    errorDoc('E_NETWORK'),
  ];
  for (const doc of docs) {
    assert.equal(headlineFor(doc), HEADLINE.unscored, JSON.stringify(doc.error));
  }
});

void test("renderComment headline is '### vetkit: failed' for a CONFIG_INVALID error document and the body shows the code and the message", () => {
  const body = renderComment({
    current: errorDoc('CONFIG_INVALID', { message: 'config file not found: nope.config.ts' }),
    baseline: runDoc([verdict('case-a', 'tone', 'pass')]),
    env: {},
  });
  assert.equal(headlineOf(body), HEADLINE.failed);
  assert.ok(body.includes('CONFIG_INVALID'), 'the error code is shown');
  assert.ok(body.includes('config file not found: nope.config.ts'), 'the message is shown');
  assert.doesNotMatch(body, /\| Case \| Change \|/);
});

void test("renderComment headline is '### vetkit: failed' for criteria, gate and unknown error codes and the body shows the code", () => {
  for (const code of [
    'CRITERIA_INVALID',
    'CASE_INVALID',
    'GATE_UNCALIBRATED',
    'GATE_UNPINNED',
    'INTERNAL',
    'SOME_CODE_ADDED_LATER',
  ]) {
    const body = renderComment({ current: errorDoc(code), baseline: undefined, env: {} });
    assert.equal(headlineOf(body), HEADLINE.failed, code);
    assert.ok(body.includes(code), `${code} is shown`);
    assert.ok(body.includes(`${code} happened`), `the ${code} message is shown`);
  }
  assert.equal(headlineFor({ error: { message: 'no code at all' } }), HEADLINE.failed);
  assert.equal(headlineFor({ error: 'a bare string' }), HEADLINE.failed);
});

void test('renderComment redacts a seeded key value in the error message', () => {
  const body = renderComment({
    current: errorDoc('CONFIG_INVALID', { message: `bad header Bearer ${FAKE_KEY} in the config` }),
    baseline: undefined,
    env: { AI_GATEWAY_API_KEY: FAKE_KEY },
  });
  assert.ok(!body.includes(FAKE_KEY), 'seeded key leaked through the error message');
  assert.ok(body.includes('bad header Bearer [redacted] in the config'));
});

void test('renderComment keeps the error message on one line and inside a code span', () => {
  const body = renderComment({
    current: errorDoc('CRITERIA_INVALID', {
      message: 'line 3:\n  unknown key `<!-- x -->` | @someone',
    }),
    baseline: undefined,
    env: {},
  });
  const line = body.split('\n').find((text) => text.includes('CRITERIA_INVALID'));
  assert.ok(line?.includes("`line 3: unknown key '<!-- x -->' \\| @someone`"), line);
});

void test("renderComment never says '### vetkit: passed' for a document that carries an error, whatever its counts and exit code", () => {
  for (const code of ['CONFIG_INVALID', 'JUDGE_UNAVAILABLE', 'JUDGE_UNAUTHORIZED', 'SINK_WRITE']) {
    const body = renderComment({
      current: { ...passingDoc(), ...errorDoc(code) },
      baseline: undefined,
      env: {},
    });
    assert.notEqual(headlineOf(body), HEADLINE.passed, code);
    assert.ok(!body.includes('vetkit: passed'), code);
  }
});

void test("renderComment headline is '### vetkit: passed' only for exit code 0: another or a missing exit code reads '### vetkit: failed'", () => {
  const passing = [verdict('case-a', 'tone', 'pass')];
  for (const exitCode of [2, 70, 130, undefined]) {
    assert.equal(headlineFor(runDoc(passing, { exitCode })), HEADLINE.failed, String(exitCode));
  }
  assert.equal(
    headlineFor(runDoc([verdict('case-a', 'tone', 'fail')], { exitCode: 0 })),
    HEADLINE.failed,
  );
  assert.equal(headlineFor({ exitCode: 0 }), HEADLINE.failed, 'no counts at all');
});

/** Runs `main` on a pull_request event over the given files and returns the posted comment body. */
async function postedBody(files, env = {}) {
  const dir = workspace({
    'event.json': JSON.stringify({ pull_request: { number: 9 } }),
    ...files,
  });
  const { gh, calls } = ghStub([{ code: 0, stdout: '', stderr: '' }]);
  const result = await main({
    env: {
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_REPOSITORY: 'o/r',
      GITHUB_EVENT_PATH: join(dir, 'event.json'),
      ...(files['report.md'] === undefined ? {} : { REPORT_MD: join(dir, 'report.md') }),
      ...env,
    },
    argv: ['comment', join(dir, 'run.json'), join(dir, 'base.json'), join(dir, 'raw.json')],
    gh,
    warn: () => {},
  });
  assert.equal(result, 'created');
  return JSON.parse(calls[1]?.stdin ?? '{}').body;
}

void test('main posts the unscored headline for a no-credit raw output and no run record', async () => {
  const posted = await postedBody({
    'raw.json': JSON.stringify(
      errorDoc('JUDGE_UNAVAILABLE', {
        message: 'judge account has no credit',
        kind: 'terminal-billing',
      }),
    ),
  });
  assert.equal(headlineOf(posted), HEADLINE.unscored);
});

void test('main posts the failed headline with the code and the message for a CONFIG_INVALID raw output', async () => {
  const posted = await postedBody({
    'raw.json': JSON.stringify(
      errorDoc('CONFIG_INVALID', { message: 'config file not found: nope.config.ts' }),
    ),
  });
  assert.equal(headlineOf(posted), HEADLINE.failed);
  assert.ok(posted.includes('CONFIG_INVALID'));
  assert.ok(posted.includes('config file not found: nope.config.ts'));
});

void test('main posts the failed headline with a one-line reason when the raw output is missing and there is no run record', async () => {
  const posted = await postedBody({});
  const lines = posted.split('\n');
  assert.equal(lines[1], HEADLINE.failed);
  assert.match(lines[3] ?? '', /produced no result/);
  assert.equal(lines.length, 4, posted);
});

void test('main posts the failed headline with a one-line reason when the raw output is not JSON and there is no run record', async () => {
  for (const raw of ['', 'npm error could not determine executable to run', '{}']) {
    const posted = await postedBody({ 'raw.json': raw });
    const lines = posted.split('\n');
    assert.equal(lines[1], HEADLINE.failed, raw);
    assert.match(lines[3] ?? '', /produced no result/, raw);
    assert.equal(lines.length, 4, posted);
  }
});

void test('main does not report a run record from an earlier run when the raw output carries an error', async () => {
  const posted = await postedBody({
    'run.json': JSON.stringify(passingDoc()),
    'report.md': '## Earlier report\n\n1 passed',
    'raw.json': JSON.stringify(errorDoc('CONFIG_INVALID')),
  });
  assert.equal(headlineOf(posted), HEADLINE.failed);
  assert.ok(posted.includes('CONFIG_INVALID'));
  assert.doesNotMatch(posted, /1 passed/);
  assert.doesNotMatch(posted, /Earlier report/);
  assert.doesNotMatch(posted, /typesafe-ai\/jev-served-1/);
});
