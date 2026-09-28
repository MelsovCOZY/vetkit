// Plain Node test runner: `node --test action/comment.test.mjs`. No network: `gh` is a stub.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
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
