import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunRecord } from '@vetkit/core';
import { safeParseJson, type Case, type Criterion, type Lock } from '@vetkit/spec';
import { describe, expect, test } from 'vitest';
import {
  buildReportModel,
  loadReportInputs,
  renderMarkdown,
  VETKIT_REPO_URL,
  VETKIT_VERSION,
  type ReportModel,
} from './report.ts';

const fixtures = fileURLToPath(new URL('../../../../fixtures/reporters/', import.meta.url));
const NO_ENV: Record<string, string | undefined> = {};

function record(over: Partial<RunRecord> = {}): RunRecord {
  const parsed = safeParseJson<RunRecord>(readFileSync(join(fixtures, 'run.json'), 'utf8'), {});
  if (!parsed.ok) throw parsed.error;
  return {
    ...parsed.value,
    $schema: 'https://example.test/run-record.schema.json',
    criteriaPath: 'evals/criteria.yaml',
    casesPath: 'evals/cases',
    startedAt: '2026-09-30T10:00:00.000Z',
    gateRequested: false,
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
    ...over,
  };
}

function boolCriterion(id: string, instructions: string, enabled?: boolean): Criterion {
  return {
    id,
    type: 'boolean',
    instructions,
    escape: 'not applicable',
    polarity: 'pass_when_true',
    channel: 'quality',
    provenance: { traceIds: [] },
    wordingHash: `hash-${id}`,
    ...(enabled === undefined ? {} : { enabled }),
  };
}

function scoreCriterion(id: string, instructions: string): Criterion {
  return {
    id,
    type: 'score',
    instructions,
    criteria: ['bad', 'good'],
    polarity: 'pass_when_true',
    channel: 'quality',
    provenance: { traceIds: [] },
    wordingHash: `hash-${id}`,
  };
}

const POLITE = boolCriterion('polite', 'Is the reply polite?');
const CITES = boolCriterion('cites-policy', 'Does the reply cite the refund policy?');
const CRITERIA: Criterion[] = [POLITE, CITES];

function lockWith(statuses: Record<string, 'calibrated' | 'uncalibrated' | 'floating'>): Lock {
  const pass = 'pass' as const;
  return {
    lockVersion: 1,
    model: { requested: 'm', resolved: 'm', transport: 't', pinned: true },
    datasetHash: 'd'.repeat(64),
    criteria: Object.fromEntries(
      Object.entries(statuses).map(([id, status]) => [
        id,
        {
          wordingHash: `hash-${id}`,
          status,
          ...(status === 'calibrated' ? { threshold: 0.7 } : {}),
          gauntlet: {
            paraphrase: pass,
            polarity: pass,
            injection: pass,
            master_key: pass,
            label_permutation: pass,
            constant_output: pass,
            position_swap: pass,
            length: pass,
          },
          reasons: [],
          labelCount: 12,
        },
      ]),
    ),
  };
}

function evalCase(id: string, state: string): Case {
  return { id, input: { state }, provenance: null, tags: [] };
}

function build(
  over: {
    record?: RunRecord;
    criteria?: readonly Criterion[];
    lock?: Lock | null;
    cases?: readonly Case[];
    includeCases?: boolean;
    env?: Record<string, string | undefined>;
  } = {},
): ReportModel {
  return buildReportModel({
    record: over.record ?? record(),
    criteria: over.criteria ?? CRITERIA,
    lock: over.lock ?? null,
    ...(over.cases === undefined ? {} : { cases: over.cases }),
    includeCases: over.includeCases ?? false,
    vetkitVersion: '9.9.9',
    env: over.env ?? NO_ENV,
  });
}

function withTransport(transport: string, over: Partial<RunRecord> = {}): RunRecord {
  const base = record();
  return record({ model: { ...base.model, transport }, ...over });
}

describe('buildReportModel', () => {
  test('buildReportModel joins byCriterion with criteria.yaml wording', () => {
    const model = build();
    expect(model.criteria.map((c) => c.id).toSorted()).toEqual(['cites-policy', 'polite']);
    const polite = model.criteria.find((c) => c.id === 'polite');
    expect(polite).toMatchObject({
      type: 'boolean',
      wording: 'Is the reply polite?',
      passed: 1,
      failed: 0,
      unscored: 0,
    });
    expect(model.counts).toMatchObject({ total: 2, passed: 1, failed: 1, exitCode: 1 });
  });

  test("a criterion missing from criteria.yaml renders '(not in criteria.yaml)'", () => {
    const model = build({ criteria: [POLITE] });
    expect(model.criteria.find((c) => c.id === 'cites-policy')?.wording).toBe(
      '(not in criteria.yaml)',
    );
    expect(renderMarkdown(model)).toContain('(not in criteria.yaml)');
  });

  test("no lock → calibration label 'uncalibrated' and per-row 'no lock'", () => {
    const model = build({ lock: null });
    expect(model.calibration.label).toBe('uncalibrated');
    for (const row of model.criteria) expect(row.calibration).toBe('no lock');
  });

  test("lock with 2 of 3 gateable calibrated and gateRequested → '2/3 calibrated, gate on'", () => {
    const criteria = [...CRITERIA, boolCriterion('third', 'Third?')];
    const lock = lockWith({
      polite: 'calibrated',
      'cites-policy': 'calibrated',
      third: 'floating',
    });
    const model = build({ criteria, lock, record: record({ gateRequested: true }) });
    expect(model.calibration.label).toBe('2/3 calibrated, gate on');
    expect(model.calibration).toMatchObject({ calibrated: 2, gateable: 3, gateRequested: true });
    const off = build({ criteria, lock });
    expect(off.calibration.label).toBe('2/3 calibrated, gate off');
    expect(model.criteria.find((c) => c.id === 'polite')).toMatchObject({
      calibration: 'calibrated',
      threshold: 0.7,
    });
  });

  test("score criteria are 'not gateable' and excluded from N/M", () => {
    const criteria = [...CRITERIA, scoreCriterion('depth', 'How deep?')];
    const lock = lockWith({
      polite: 'calibrated',
      'cites-policy': 'uncalibrated',
      depth: 'calibrated',
    });
    const base = record();
    const rec = record({
      summary: {
        ...base.summary,
        byCriterion: {
          ...base.summary.byCriterion,
          depth: { total: 1, passed: 1, failed: 0, unscored: 0, saturated: null },
        },
      },
    });
    const model = build({ criteria, lock, record: rec });
    expect(model.criteria.find((c) => c.id === 'depth')?.calibration).toBe('not gateable');
    expect(model.calibration).toMatchObject({ calibrated: 1, gateable: 2 });
    expect(model.calibration.label).toBe('1/2 calibrated, gate off');
  });

  test("transport 'demo' sets demo, the '> demo run' blockquote, badge state 'demo' and colour lightgrey for every exit code; transport 'fake' does not", () => {
    for (const exitCode of [0, 1, 2, 3, 130]) {
      const model = build({ record: withTransport('demo', { exitCode }) });
      expect(model.demo).toBe(true);
      expect(model.badge.color).toBe('lightgrey');
      expect(model.badge.message.startsWith('demo · ')).toBe(true);
      expect(model.calibration.label).toBe('demo · uncalibrated');
      expect(renderMarkdown(model)).toContain('> demo run');
    }
    const fake = build({ record: withTransport('fake') });
    expect(fake.demo).toBe(false);
    expect(fake.badge.message.startsWith('demo')).toBe(false);
    expect(renderMarkdown(fake)).not.toContain('> demo run');
  });

  test('pinned: false produces a one-line pinnedNote; pinned: true produces none', () => {
    const unpinned = build();
    expect(unpinned.model.pinned).toBe(false);
    expect(unpinned.model.pinnedNote).toMatch(/^pinned: false/);
    expect(unpinned.model.pinnedNote).not.toContain('\n');
    const base = record();
    const pinned = build({ record: record({ model: { ...base.model, pinned: true } }) });
    expect(pinned.model.pinnedNote).toBeUndefined();
    expect(renderMarkdown(pinned)).not.toContain('pinned: false');
  });

  test('model name is the resolved id, or the requested one when resolved is empty', () => {
    expect(build().model.name).toBe('typesafe-ai/jev-2026-09');
    const base = record();
    const rec = record({ model: { ...base.model, resolved: '' } });
    expect(build({ record: rec }).model.name).toBe('typesafe-ai/jev');
  });

  test('badge message per exitCode/gateRequested matrix (0/1/2/3/130 × on/off) never contains passed or total counts', () => {
    const expected: Record<number, [string, string]> = {
      0: ['pass', 'gate pass'],
      1: ['fail', 'gate fail'],
      2: ['gate refused', 'gate refused'],
      3: ['unscored', 'unscored'],
      130: ['aborted', 'aborted'],
    };
    for (const [code, [off, on]] of Object.entries(expected)) {
      for (const gateRequested of [false, true]) {
        const model = build({ record: record({ exitCode: Number(code), gateRequested }) });
        expect(model.badge.message).toBe(`uncalibrated · ${gateRequested ? on : off}`);
        expect(model.badge).toMatchObject({ schemaVersion: 1, label: 'vetkit' });
        expect(model.badge.message).not.toMatch(/passed|%|\d+\s*\/\s*\d+ pass/);
      }
    }
    const lock = lockWith({ polite: 'calibrated', 'cites-policy': 'calibrated' });
    const calibrated = build({ lock, record: record({ exitCode: 0, gateRequested: true }) });
    expect(calibrated.badge.message).toBe('2/2 calibrated · gate pass');
  });

  test('badge color matrix', () => {
    const lock = lockWith({ polite: 'calibrated', 'cites-policy': 'calibrated' });
    const color = (exitCode: number, gateRequested: boolean, withLock: boolean): string =>
      build({
        lock: withLock ? lock : null,
        record: record({ exitCode, gateRequested }),
      }).badge.color;
    expect(color(1, false, false)).toBe('red');
    expect(color(1, true, true)).toBe('red');
    expect(color(2, true, false)).toBe('orange');
    expect(color(3, false, false)).toBe('lightgrey');
    expect(color(130, false, false)).toBe('lightgrey');
    expect(color(0, false, false)).toBe('yellow');
    expect(color(0, true, false)).toBe('yellow');
    expect(color(0, false, true)).toBe('yellow');
    expect(color(0, true, true)).toBe('brightgreen');
  });

  test('failedCases lists distinct sorted ids of scored failures only (unscored and gated:false excluded)', () => {
    const base = record();
    const model = base.model;
    const v = (
      caseId: string,
      criterionId: string,
      extra: Record<string, unknown>,
    ): RunRecord['results'][number] => ({
      caseId,
      criterionId,
      status: 'ok',
      pass: false,
      model,
      cacheHit: false,
      ...extra,
    });
    const rec = record({
      results: [
        v('zeta', 'polite', {}),
        v('zeta', 'cites-policy', {}),
        v('alpha', 'polite', {}),
        v('beta', 'polite', { pass: true }),
        v('gamma', 'polite', { status: 'unscored', pass: undefined }),
        v('delta', 'polite', { gated: false, gateReason: 'score_not_gateable' }),
      ],
    });
    expect(build({ record: rec }).failedCases).toEqual(['alpha', 'zeta']);
  });

  test('a case with a flaky verdict has outcome flaky', () => {
    const base = record();
    const flakyVerdict = {
      caseId: 'c1',
      criterionId: 'polite',
      status: 'ok' as const,
      pass: true,
      model: base.model,
      cacheHit: false,
      flaky: true,
    };
    const rec = record({ results: [flakyVerdict] });
    const model = build({ record: rec, cases: [evalCase('c1', 'hi')], includeCases: true });
    expect(model.cases?.[0]?.outcome).toBe('flaky');
  });

  test('includeCases adds redacted, 400-char-capped state; without it no case text appears in the Markdown', () => {
    const cases = [
      evalCase('refund-1', 'User: hi\nAssistant: Hello! How can I help?'),
      evalCase('long', 'x '.repeat(400)),
      evalCase('secret', 'my key is sk-abcdef123456789'),
    ];
    const withCases = build({ cases, includeCases: true });
    const md = renderMarkdown(withCases);
    expect(withCases.cases).toHaveLength(3);
    expect(md).toContain('Hello! How can I help?');
    expect(md).not.toContain('sk-abcdef123456789');
    const long = withCases.cases?.find((c) => c.id === 'long');
    expect(long?.state.length).toBeLessThanOrEqual(401);
    expect(long?.state.endsWith('…')).toBe(true);
    const without = build({ cases, includeCases: false });
    expect(without.cases).toBeUndefined();
    expect(renderMarkdown(without)).not.toContain('Hello! How can I help?');
    expect(without.datasetHash).toMatch(/^[0-9a-f]{64}$/);
    expect(build({}).datasetHash).toBeUndefined();
    expect(renderMarkdown(build({}))).toContain('Dataset `unavailable`');
  });

  test('explanation/cause/answer text never appears in the Markdown', () => {
    const base = record();
    const rec = record({
      results: [
        {
          caseId: 'c1',
          criterionId: 'polite',
          status: 'ok',
          pass: false,
          model: base.model,
          cacheHit: false,
          explanation: 'EXPLANATION-MARKER',
          cause: 'CAUSE-MARKER',
          answer: { type: 'choice', choice: 'ANSWER-MARKER', confidence: 1, probabilities: {} },
        },
      ],
    });
    const md = renderMarkdown(build({ record: rec }));
    for (const marker of ['EXPLANATION-MARKER', 'CAUSE-MARKER', 'ANSWER-MARKER']) {
      expect(md).not.toContain(marker);
    }
  });

  test('a KEY-named env value inside wording is masked', () => {
    const criteria = [
      boolCriterion('polite', 'Is it polite? token hunter2-secret-value here'),
      CITES,
    ];
    const model = build({ criteria, env: { MY_API_KEY: 'hunter2-secret-value' } });
    expect(JSON.stringify(model)).not.toContain('hunter2-secret-value');
    expect(renderMarkdown(model)).not.toContain('hunter2-secret-value');
  });

  test('a key-shaped string inside a criterion wording is masked', () => {
    const criteria = [boolCriterion('polite', 'Polite? sk-abcdef123456789'), CITES];
    expect(renderMarkdown(build({ criteria }))).not.toContain('sk-abcdef123456789');
  });

  test('a gate-refused run with no results renders zero-count rows and the gate reasons', () => {
    const rec = record({
      results: [],
      exitCode: 2,
      gateReasons: ['no lock: run `vet validate`'],
      summary: { total: 0, passed: 0, failed: 0, unscored: 0, aborted: false, byCriterion: {} },
    });
    const model = build({ record: rec });
    expect(model.failedCases).toEqual([]);
    expect(model.gateReasons).toEqual(['no lock: run `vet validate`']);
    expect(model.criteria.map((c) => c.id).toSorted()).toEqual(['cites-policy', 'polite']);
    const md = renderMarkdown(model);
    expect(md).toContain('Gate refused: no lock: run `vet validate`');
    expect(md).not.toContain('Failed cases');
  });
});

describe('renderMarkdown', () => {
  test("renderMarkdown starts with '### vetkit eval report' and contains no '<!--' and no '<script'", () => {
    const md = renderMarkdown(build());
    expect(md.startsWith('### vetkit eval report\n')).toBe(true);
    expect(md).not.toContain('<!--');
    expect(md).not.toContain('<script');
    expect(md).not.toMatch(/^# /m);
  });

  test('renders counts, calibration, model, table, footer and the repo link', () => {
    const md = renderMarkdown(build());
    expect(md).toContain('**1 passed · 1 failed · 0 unscored** of 2 · exit 1');
    expect(md).toContain('Calibration: uncalibrated — run `vet validate` to calibrate thresholds');
    expect(md).toContain(
      'Model: `typesafe-ai/jev-2026-09` (transport vercel-ai-gateway, pinned: false)',
    );
    expect(md).toContain('| Criterion | Wording | Pass | Fail | Unscored | Calibration |');
    expect(md).toContain('| `polite` | Is the reply polite? | 1 | 0 | 0 | no lock |');
    expect(md).toContain('Failed cases: `refund-1`');
    expect(md).toContain(
      `vetkit 9.9.9 · started 2026-09-30T10:00:00.000Z · [vetkit](${VETKIT_REPO_URL})`,
    );
  });

  test('marks an aborted run and escapes pipes in wording cells', () => {
    const base = record();
    const rec = record({ exitCode: 130, summary: { ...base.summary, aborted: true } });
    const criteria = [boolCriterion('polite', 'a | b\n  c'), CITES];
    const md = renderMarkdown(build({ record: rec, criteria }));
    expect(md).toContain('of 2 (aborted) · exit 130');
    expect(md).toContain('a \\| b c');
  });

  test('renderMarkdown caps failed cases at 20 and cases at 50', () => {
    const ids = Array.from({ length: 300 }, (_v, i) => `case-${String(i).padStart(4, '0')}`);
    const base = record();
    const rec = record({
      results: ids.map((caseId) => ({
        caseId,
        criterionId: 'polite',
        status: 'ok' as const,
        pass: false,
        model: base.model,
        cacheHit: false,
      })),
    });
    const cases = ids.map((id) => evalCase(id, 'state'));
    const md = renderMarkdown(build({ record: rec, cases, includeCases: true }));
    expect(md).toContain('(+280 more)');
    expect(md).toContain('`case-0019`');
    expect(md).not.toContain(
      'Failed cases: `case-0000`, `case-0001`, `case-0002`, `case-0003`, `case-0004`, `case-0005`, `case-0006`, `case-0007`, `case-0008`, `case-0009`, `case-0010`, `case-0011`, `case-0012`, `case-0013`, `case-0014`, `case-0015`, `case-0016`, `case-0017`, `case-0018`, `case-0019`, `case-0020`',
    );
    const caseRows = md.split('\n').filter((l) => l.startsWith('| `case-'));
    expect(caseRows).toHaveLength(50);
    expect(md).toContain('<summary>Cases (300)</summary>');
  });

  test('2,000-case record renders under 60,000 characters', () => {
    const ids = Array.from({ length: 2000 }, (_v, i) => `case-${String(i).padStart(4, '0')}`);
    const base = record();
    const rec = record({
      results: ids.map((caseId) => ({
        caseId,
        criterionId: 'polite',
        status: 'ok' as const,
        pass: false,
        model: base.model,
        cacheHit: false,
      })),
    });
    const cases = ids.map((id) => evalCase(id, 'y '.repeat(300)));
    const md = renderMarkdown(build({ record: rec, cases, includeCases: true }));
    expect(md.length).toBeLessThan(60_000);
  });

  test('renderMarkdown is pure (same input, same output)', () => {
    const model = build({ cases: [evalCase('a', 's')], includeCases: true });
    const snapshot = structuredClone(model);
    expect(renderMarkdown(model)).toBe(renderMarkdown(model));
    expect(model).toEqual(snapshot);
  });

  test('exports the repo url and a semver version', () => {
    expect(VETKIT_REPO_URL).toBe('https://github.com/MelsovCOZY/vetkit');
    expect(VETKIT_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vetkit-report-'));
  mkdirSync(join(dir, 'evals'), { recursive: true });
  writeFileSync(
    join(dir, 'evals', 'criteria.yaml'),
    'criteria:\n  - id: polite\n    type: boolean\n    instructions: Is the reply polite?\n    escape: none\n    polarity: pass_when_true\n    channel: quality\n    provenance:\n      traceIds: []\n',
  );
  return dir;
}

describe('loadReportInputs', () => {
  test('loadReportInputs resolves relative record paths against rootDir and returns cases: undefined with a warning when the cases dir is missing', async () => {
    const rootDir = project();
    const inputs = await loadReportInputs({ rootDir, record: record(), includeCases: false });
    expect(inputs.criteria.map((c) => c.id)).toEqual(['polite']);
    expect(inputs.lock).toBeNull();
    expect(inputs.cases).toBeUndefined();
    expect(inputs.warnings.length).toBeGreaterThan(0);
  });

  test('loadReportInputs loads cases when the directory exists', async () => {
    const rootDir = project();
    mkdirSync(join(rootDir, 'evals', 'cases'));
    writeFileSync(
      join(rootDir, 'evals', 'cases', 'cases.jsonl'),
      `${JSON.stringify(evalCase('c1', 'hello'))}\n`,
    );
    const inputs = await loadReportInputs({ rootDir, record: record(), includeCases: true });
    expect(inputs.cases?.map((c) => c.id)).toEqual(['c1']);
    expect(inputs.warnings).toEqual([]);
  });

  test('loadReportInputs throws CASE_INVALID when includeCases and the cases dir is missing', async () => {
    const rootDir = project();
    await expect(
      loadReportInputs({ rootDir, record: record(), includeCases: true }),
    ).rejects.toMatchObject({ code: 'CASE_INVALID' });
  });
});
