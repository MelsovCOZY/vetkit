import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunRecord } from '@vetkit/core';
import { safeParseJson, type Case, type Criterion } from '@vetkit/spec';
import { describe, expect, test } from 'vitest';
import { renderHtml } from './html.ts';
import { buildReportModel, renderMarkdown, VETKIT_REPO_URL, type ReportModel } from './report.ts';

const fixtures = fileURLToPath(new URL('../../../../fixtures/reporters/', import.meta.url));

function record(transport?: string): RunRecord {
  const parsed = safeParseJson<RunRecord>(readFileSync(join(fixtures, 'run.json'), 'utf8'), {});
  if (!parsed.ok) throw parsed.error;
  return {
    ...parsed.value,
    ...(transport === undefined ? {} : { model: { ...parsed.value.model, transport } }),
    $schema: 'https://example.test/run-record.schema.json',
    criteriaPath: 'evals/criteria.yaml',
    casesPath: 'evals/cases',
    startedAt: '2026-09-30T10:00:00.000Z',
    gateRequested: false,
    gateReasons: ['no lock <yet> & more'],
    summary: {
      total: 2,
      passed: 1,
      failed: 1,
      unscored: 0,
      aborted: false,
      byCriterion: {
        polite: { total: 2, passed: 1, failed: 0, unscored: 0, saturated: null },
        'cites-policy': { total: 2, passed: 0, failed: 1, unscored: 1, saturated: null },
      },
    },
  };
}

function criterion(id: string, instructions: string): Criterion {
  return {
    id,
    type: 'boolean',
    instructions,
    escape: 'none',
    polarity: 'pass_when_true',
    channel: 'quality',
    provenance: { traceIds: [] },
    wordingHash: `hash-${id}`,
  };
}

function model(
  over: { wording?: string; cases?: readonly Case[]; transport?: string } = {},
): ReportModel {
  return buildReportModel({
    record: record(over.transport),
    criteria: [
      criterion('polite', over.wording ?? 'Is the reply polite?'),
      criterion('cites-policy', 'Does it cite policy?'),
    ],
    lock: null,
    ...(over.cases === undefined ? {} : { cases: over.cases }),
    includeCases: over.cases !== undefined,
    vetkitVersion: '9.9.9',
    env: {},
  });
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

describe('renderHtml', () => {
  test('starts with <!doctype html> and declares charset and generator', () => {
    const html = renderHtml(model());
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('<meta name="generator" content="vetkit 9.9.9">');
    expect(html).toContain('<html lang="en">');
    expect(html.endsWith('\n')).toBe(true);
  });

  test('contains the criterion wording, calibration label, model name, pinned flag and note, dataset hash, vetkit version, startedAt and the repo link', () => {
    const cases = [{ id: 'c1', input: { state: 'hi' }, provenance: null, tags: [] }];
    const m = model({ cases });
    const html = renderHtml(m);
    expect(html).toContain('Is the reply polite?');
    expect(html).toContain('Calibration: uncalibrated');
    expect(html).toContain('typesafe-ai/jev-2026-09');
    expect(html).toContain('pinned: false');
    expect(html).toContain(escapeHtml(m.model.pinnedNote ?? 'missing'));
    expect(html).toContain(m.datasetHash ?? 'missing');
    expect(html).toContain('9.9.9');
    expect(html).toContain('2026-09-30T10:00:00.000Z');
    expect(html).toContain(`href="${VETKIT_REPO_URL}"`);
    expect(html).toContain('no lock &lt;yet&gt; &amp; more');
    expect(html).toContain('<th scope="col">Criterion</th>');
  });

  test('contains no <script and no external http(s) resource other than the repo link', () => {
    const html = renderHtml(model());
    expect(html).not.toContain('<script');
    expect(html).not.toMatch(/<link\b|@import|url\(/);
    const urls = html.match(/https?:\/\/[^\s"'<)]+/g) ?? [];
    for (const url of urls) expect(url).toBe(VETKIT_REPO_URL);
  });

  test('escapes < > & " \' in ids, wording and case state (fixture id `refund-<2>&co`)', () => {
    const cases = [
      { id: 'refund-<2>&co', input: { state: `<b>"x"</b> & 'y'` }, provenance: null, tags: [] },
    ];
    const html = renderHtml(model({ wording: `say "hi" <i>& 'bye'`, cases }));
    expect(html).toContain('refund-&lt;2&gt;&amp;co');
    expect(html).not.toContain('refund-<2>');
    expect(html).toContain(escapeHtml(`say "hi" <i>& 'bye'`));
    expect(html).toContain(escapeHtml(`<b>"x"</b> & 'y'`));
    expect(html).not.toContain('<b>"x"');
  });

  test('a wording containing </textarea> cannot close the Markdown textarea', () => {
    const html = renderHtml(model({ wording: 'evil </textarea><script>alert(1)</script>' }));
    expect(html).toContain('&lt;/textarea&gt;');
    expect(html).not.toContain('<script');
    expect(html.match(/<\/textarea>/g)).toHaveLength(1);
  });

  test('case text absent unless model.cases is present', () => {
    const html = renderHtml(model());
    expect(html).not.toContain('Cases</summary>');
    const withCases = renderHtml(
      model({
        cases: [{ id: 'c1', input: { state: 'CASE-TEXT-MARKER' }, provenance: null, tags: [] }],
      }),
    );
    expect(withCases).toContain('CASE-TEXT-MARKER');
    expect(html).not.toContain('CASE-TEXT-MARKER');
  });

  test('demo model renders the demo banner', () => {
    expect(renderHtml(model({ transport: 'demo' }))).toContain('class="demo"');
    expect(renderHtml(model())).not.toContain('class="demo"');
  });

  test('the Copy-as-Markdown textarea equals renderMarkdown(model) escaped', () => {
    const m = model();
    const html = renderHtml(m);
    const match = /<textarea readonly[^>]*>([\s\S]*?)<\/textarea>/.exec(html);
    expect(match?.[1]).toBe(escapeHtml(renderMarkdown(m)));
  });

  test('an unknown badge colour still renders the message', () => {
    const m = model();
    const html = renderHtml({ ...m, badge: { ...m.badge, color: 'chartreuse' } });
    expect(html).toContain(escapeHtml(m.badge.message));
  });

  test('lists every failed case id with no cap', () => {
    const ids = Array.from({ length: 60 }, (_v, i) => `case-${String(i).padStart(3, '0')}`);
    const m = model();
    const html = renderHtml({ ...m, failedCases: ids });
    for (const id of ids) expect(html).toContain(id);
  });

  test('is pure: same model, same output', () => {
    const m = model();
    expect(renderHtml(m)).toBe(renderHtml(m));
  });
});
