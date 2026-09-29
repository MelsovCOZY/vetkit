// A/B experiment: does the fenced-v1 judge request format change how a judge handles injected
// case states? Runs the raw and fenced-v1 arms against the same cases on OpenRouter and prints
// flips/n per injection family (95% Wilson CI), known-pass agreement and known-fail accuracy.
// Live runs bill the judge key; not part of the fast suite (nothing imports this file).
//
//   bun scripts/ab-request-format.ts --dry-run
//   OPENROUTER_API_KEY=... bun scripts/ab-request-format.ts [--out results.json] [--max-calls 300]
//
// Data is read in place from fixtures/projects/j3 (read-only). No cache, one repeat per call,
// and no request or response body is ever logged: only counts and error codes.
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_GAUNTLET_CORPORA, judgeCase, loadCases, loadCriteria } from '@vetkit/core';
import { createJevJudgeFromEndpoint } from '@vetkit/judge-jev';
import type { Case, Criterion, RequestFormat } from '@vetkit/spec';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT = join(ROOT, 'fixtures/projects/j3');
const LABELS = join(ROOT, 'fixtures/labels/answer_correct.csv');
const CRITERION_ID = 'answer_correct';
const FAMILIES = ['fake_instruction_output', 'encoding'] as const;
const ARMS: readonly RequestFormat[] = ['raw', 'fenced-v1'];
// Same separator the gauntlet appends injections with (gauntlet-controls.ts, not exported).
const INJECTION_SEPARATOR = '\n\n';
const CONCURRENCY = 4;

/** 95% Wilson score interval for k successes of n. */
function wilson(k: number, n: number): [number, number] {
  if (n === 0) return [0, 1];
  const z = 1.96;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

interface Job {
  readonly arm: RequestFormat;
  readonly kind: 'pass-original' | 'fail-original' | 'injected';
  readonly family?: string;
  readonly baseId: string;
  readonly repeat: number;
  readonly evalCase: Case;
}
interface Outcome {
  readonly job: Job;
  readonly status: 'pass' | 'fail' | 'unscored';
  readonly cause?: string;
}

function readLabels(): Map<string, 'pass' | 'fail'> {
  const labels = new Map<string, 'pass' | 'fail'>();
  for (const line of readFileSync(LABELS, 'utf8').split('\n').slice(1)) {
    const [id, criterion, label] = line.split(',');
    if (id === undefined || criterion !== CRITERION_ID) continue;
    if (label === 'pass' || label === 'fail') labels.set(id, label);
  }
  return labels;
}

async function loadData(
  knownPass: number,
  knownFail: number,
): Promise<{
  criterion: Criterion;
  passes: Case[];
  fails: Case[];
  failPool: number;
}> {
  const criteria = await loadCriteria(join(PROJECT, 'evals/criteria.yaml'));
  if (!criteria.ok) throw new Error('cannot load fixture criteria');
  const criterion = criteria.criteria.find((c) => c.id === CRITERION_ID);
  if (criterion === undefined) throw new Error(`fixture has no ${CRITERION_ID} criterion`);
  const cases = await loadCases(join(PROJECT, 'evals/cases'));
  if (!cases.ok) throw new Error('cannot load fixture cases');
  const labels = readLabels();
  const sorted = cases.cases.toSorted((a, b) => (a.id < b.id ? -1 : 1));
  const of = (label: string): Case[] => sorted.filter((c) => labels.get(c.id) === label);
  return {
    criterion,
    passes: of('pass').slice(0, knownPass),
    fails: of('fail').slice(0, knownFail),
    failPool: of('fail').length,
  };
}

function buildJobs(passes: readonly Case[], fails: readonly Case[], repeats: number): Job[] {
  const injections = DEFAULT_GAUNTLET_CORPORA.injections.filter((i) =>
    (FAMILIES as readonly string[]).includes(i.kind),
  );
  const repeatIdx = Array.from({ length: repeats }, (_, i) => i);
  return ARMS.flatMap((arm) =>
    repeatIdx.flatMap((repeat) => [
      ...passes.map((c): Job => ({
        arm,
        kind: 'pass-original',
        repeat,
        baseId: c.id,
        evalCase: c,
      })),
      ...fails.flatMap((c): Job[] => [
        { arm, kind: 'fail-original', repeat, baseId: c.id, evalCase: c },
        ...injections.map((inj): Job => ({
          arm,
          kind: 'injected',
          repeat,
          family: inj.kind,
          baseId: c.id,
          evalCase: {
            ...c,
            id: `${c.id}#injection:${inj.id}`,
            input: { ...c.input, state: `${c.input.state}${INJECTION_SEPARATOR}${inj.text}` },
          },
        })),
      ]),
    ]),
  );
}

function causeOf(cause: unknown): string {
  return typeof cause === 'string' ? cause : 'unknown';
}

async function runJobs(
  jobs: readonly Job[],
  criterion: Criterion,
  judges: Record<RequestFormat, ReturnType<typeof createJevJudgeFromEndpoint>>,
): Promise<Outcome[]> {
  const out: Outcome[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const job = jobs[next++];
      if (job === undefined) return;
      const [verdict] = await judgeCase({
        judge: judges[job.arm],
        case: job.evalCase,
        criteria: [criterion],
      });
      if (verdict === undefined || verdict.status !== 'ok') {
        out.push({ job, status: 'unscored', cause: causeOf(verdict?.cause ?? verdict?.status) });
      } else {
        out.push({ job, status: verdict.pass === true ? 'pass' : 'fail' });
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return out;
}

interface FamilyStat {
  flips: number;
  n: number;
  ci: [number, number];
}
interface ArmReport {
  arm: RequestFormat;
  families: Record<string, FamilyStat>;
  knownPass: { judgedPass: number; scored: number };
  knownFail: { judgedFail: number; scored: number };
  unscored: { total: number; causes: Record<string, number> };
}

function tally(arm: RequestFormat, outcomes: readonly Outcome[]): ArmReport {
  const mine = outcomes.filter((o) => o.job.arm === arm);
  const count = (pred: (o: Outcome) => boolean): number => mine.filter(pred).length;
  const originalFailed = new Set(
    mine
      .filter((o) => o.job.kind === 'fail-original' && o.status === 'fail')
      .map((o) => o.job.baseId),
  );
  const families: Record<string, FamilyStat> = {};
  for (const family of FAMILIES) {
    const trials = mine.filter(
      (o) =>
        o.job.kind === 'injected' &&
        o.job.family === family &&
        o.status !== 'unscored' &&
        originalFailed.has(`${o.job.baseId}#${String(o.job.repeat)}`),
    );
    const flips = trials.filter((o) => o.status === 'pass').length;
    families[family] = { flips, n: trials.length, ci: wilson(flips, trials.length) };
  }
  const causes: Record<string, number> = {};
  for (const o of mine) {
    if (o.status === 'unscored')
      causes[o.cause ?? 'unknown'] = (causes[o.cause ?? 'unknown'] ?? 0) + 1;
  }
  return {
    arm,
    families,
    knownPass: {
      judgedPass: count((o) => o.job.kind === 'pass-original' && o.status === 'pass'),
      scored: count((o) => o.job.kind === 'pass-original' && o.status !== 'unscored'),
    },
    knownFail: {
      judgedFail: count((o) => o.job.kind === 'fail-original' && o.status === 'fail'),
      scored: count((o) => o.job.kind === 'fail-original' && o.status !== 'unscored'),
    },
    unscored: { total: count((o) => o.status === 'unscored'), causes },
  };
}

const pct = (x: number): string => `${(x * 100).toFixed(0)}%`;

function printTable(reports: readonly ArmReport[]): void {
  const rows: string[][] = [
    ['arm', 'metric', 'value'],
    ...reports.flatMap((r) => [
      ...Object.entries(r.families).map(([family, s]) => [
        r.arm,
        `flips ${family}`,
        `${String(s.flips)}/${String(s.n)} CI [${pct(s.ci[0])}, ${pct(s.ci[1])}]`,
      ]),
      [
        r.arm,
        'known-pass judged pass',
        `${String(r.knownPass.judgedPass)}/${String(r.knownPass.scored)}`,
      ],
      [
        r.arm,
        'known-fail judged fail',
        `${String(r.knownFail.judgedFail)}/${String(r.knownFail.scored)}`,
      ],
      [r.arm, 'unscored', `${String(r.unscored.total)} ${JSON.stringify(r.unscored.causes)}`],
    ]),
  ];
  const widths = [0, 1, 2].map((i) => Math.max(...rows.map((row) => (row[i] ?? '').length)));
  for (const row of rows) {
    console.log(row.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join('  '));
  }
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      'dry-run': { type: 'boolean', default: false },
      out: { type: 'string' },
      'max-calls': { type: 'string', default: '300' },
      'known-pass': { type: 'string', default: '25' },
      'known-fail': { type: 'string', default: '8' },
      repeats: { type: 'string', default: '1' },
    },
  });
  const maxCalls = Number(values['max-calls']);
  if (!Number.isInteger(maxCalls) || maxCalls < 1) {
    console.error('--max-calls must be a positive integer');
    return 2;
  }
  const [nPass, nFail, repeats] = [
    Number(values['known-pass']),
    Number(values['known-fail']),
    Number(values.repeats),
  ];
  if (![nPass, nFail, repeats].every((n) => Number.isInteger(n) && n >= 1)) {
    console.error('--known-pass, --known-fail and --repeats must be positive integers');
    return 2;
  }
  const { criterion, passes, fails, failPool } = await loadData(nPass, nFail);
  console.log(`known-fail pool: ${String(failPool)}; using ${String(fails.length)}`);
  const jobs = buildJobs(passes, fails, repeats);
  const perArm = jobs.length / ARMS.length / repeats;
  console.log(
    `plan: ${String(jobs.length)} calls = ${String(ARMS.length)} arms (${ARMS.join(', ')}) x ` +
      `${String(repeats)} repeats x (${String(passes.length)} known-pass + ${String(fails.length)} known-fail originals + ` +
      `${String(perArm - passes.length - fails.length)} injected known-fail); criterion ${CRITERION_ID}; ` +
      `families ${FAMILIES.join(', ')}; no cache, ${String(repeats)} repeat(s); cap ${String(maxCalls)}`,
  );
  if (jobs.length > maxCalls) {
    console.error(
      `refusing: planned ${String(jobs.length)} calls exceed --max-calls ${String(maxCalls)}`,
    );
    return 2;
  }
  if (values['dry-run']) return 0;

  const apiKey = process.env['OPENROUTER_API_KEY'];
  if (apiKey === undefined || apiKey === '') {
    console.error('OPENROUTER_API_KEY is not set');
    return 2;
  }
  const make = (requestFormat: RequestFormat): ReturnType<typeof createJevJudgeFromEndpoint> =>
    createJevJudgeFromEndpoint(
      { preset: 'openrouter', apiKeyEnv: 'OPENROUTER_API_KEY', requestFormat },
      { apiKey },
    );
  const outcomes = await runJobs(jobs, criterion, {
    raw: make('raw'),
    'fenced-v1': make('fenced-v1'),
  });
  const reports = ARMS.map((arm) => tally(arm, outcomes));
  printTable(reports);
  const outPath = values.out ?? join(tmpdir(), `ab-request-format-${String(Date.now())}.json`);
  writeFileSync(outPath, `${JSON.stringify({ calls: jobs.length, reports }, null, 2)}\n`);
  console.log(`wrote ${outPath}`);
  return 0;
}

process.exitCode = await main();
