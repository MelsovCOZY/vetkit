// The shareable rendering of a run: a pure model built from the run record, its criteria file,
// the lock and (optionally) the cases, plus the Markdown serializer. The HTML report, the badge
// and `vet report` all consume the same model, so every shared artifact states the same
// calibration, model and version. Judge explanations, causes and answers are never read.
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import {
  datasetHash,
  loadCases,
  loadCriteria,
  LOCK_FILE,
  readLockOrNull,
  type RunRecord,
} from '@vetkit/core';
import { CEV_ERROR_CODES, VetError, type Case, type Criterion, type Lock } from '@vetkit/spec';
import { redact } from '../redact.ts';

export const VETKIT_REPO_URL = 'https://github.com/MelsovCOZY/vetkit';

const require = createRequire(import.meta.url);

function readVersion(): string {
  const pkgJson = require('../../package.json');
  return pkgJson.version;
}

export const VETKIT_VERSION: string = readVersion();

/** A run whose verdicts come from the built-in demo judge; its transport is `demo`. */
const DEMO_TRANSPORT = 'demo';
const STATE_CAP = 400;
const NOT_IN_CRITERIA = '(not in criteria.yaml)';

type Env = Record<string, string | undefined>;
type CriterionCalibration = 'calibrated' | 'uncalibrated' | 'floating' | 'not gateable' | 'no lock';

interface ReportBadge {
  readonly schemaVersion: 1;
  readonly label: 'vetkit';
  readonly message: string;
  readonly color: string;
}

interface ReportCriterionRow {
  readonly id: string;
  readonly type: Criterion['type'] | 'unknown';
  readonly wording: string;
  readonly passed: number;
  readonly failed: number;
  readonly unscored: number;
  readonly calibration: CriterionCalibration;
  readonly threshold?: number;
}

interface ReportCaseRow {
  readonly id: string;
  readonly outcome: 'pass' | 'fail' | 'unscored' | 'flaky';
  readonly state: string;
}

export interface ReportModel {
  readonly demo: boolean;
  readonly counts: {
    readonly total: number;
    readonly passed: number;
    readonly failed: number;
    readonly unscored: number;
    readonly aborted: boolean;
    readonly exitCode: number;
  };
  readonly calibration: {
    readonly calibrated: number;
    readonly gateable: number;
    readonly gateRequested: boolean;
    readonly label: string;
  };
  readonly gateReasons: string[];
  readonly model: {
    readonly name: string;
    readonly transport: string;
    readonly pinned: boolean;
    readonly pinnedNote?: string;
  };
  readonly criteria: ReportCriterionRow[];
  readonly failedCases: string[];
  readonly cases?: ReportCaseRow[];
  readonly datasetHash?: string;
  readonly vetkitVersion: string;
  readonly repoUrl: string;
  readonly startedAt: string;
  readonly badge: ReportBadge;
}

export interface BuildReportModelInput {
  readonly record: RunRecord;
  readonly criteria: readonly Criterion[];
  readonly lock: Lock | null;
  readonly cases?: readonly Case[];
  readonly includeCases: boolean;
  readonly vetkitVersion: string;
  readonly env?: Env;
}

const PINNED_NOTE =
  'pinned: false — this transport serves a floating alias, so the served model id can change between runs; gate with a pinned transport or set gate.allowUnpinned deliberately';

function isGateable(criterion: Criterion): boolean {
  return criterion.type !== 'score' && criterion.enabled !== false;
}

function rowCalibration(
  type: ReportCriterionRow['type'],
  lock: Lock | null,
  id: string,
): CriterionCalibration {
  if (type === 'score') return 'not gateable';
  if (lock === null) return 'no lock';
  return lock.criteria[id]?.status ?? 'uncalibrated';
}

function badgeResult(exitCode: number, gateRequested: boolean): string {
  switch (exitCode) {
    case 0:
      return gateRequested ? 'gate pass' : 'pass';
    case 1:
      return gateRequested ? 'gate fail' : 'fail';
    case 2:
      return 'gate refused';
    case 3:
      return 'unscored';
    case 130:
      return 'aborted';
    default:
      return `exit ${String(exitCode)}`;
  }
}

function badgeColor(
  demo: boolean,
  exitCode: number,
  gateRequested: boolean,
  calibrated: number,
): string {
  if (demo) return 'lightgrey';
  if (exitCode === 1) return 'red';
  if (exitCode === 2) return 'orange';
  if (exitCode === 0) return gateRequested && calibrated > 0 ? 'brightgreen' : 'yellow';
  return 'lightgrey';
}

type Verdicts = RunRecord['results'];

// The same precedence core uses for a case: a scored failure wins, then flaky, then unscored.
function caseOutcome(verdicts: Verdicts): ReportCaseRow['outcome'] {
  if (verdicts.length === 0) return 'unscored';
  const isFlaky = (v: Verdicts[number]): boolean => 'flaky' in v && v['flaky'] === true;
  const steady = verdicts.filter((v) => !isFlaky(v));
  if (steady.some((v) => v.status === 'ok' && v.pass !== true)) return 'fail';
  if (steady.length < verdicts.length) return 'flaky';
  if (steady.some((v) => v.status !== 'ok' && v.status !== 'not_applicable')) return 'unscored';
  return 'pass';
}

function cap(state: string): string {
  return state.length > STATE_CAP ? `${state.slice(0, STATE_CAP)}…` : state;
}

/** Pure: joins the record with criteria.yaml wording and the lock's calibration state. */
export function buildReportModel(input: BuildReportModelInput): ReportModel {
  const { record, criteria, lock, cases, includeCases, vetkitVersion } = input;
  const env = input.env ?? process.env;
  const r = (text: string): string => redact(text, env);
  const demo = record.model.transport === DEMO_TRANSPORT;
  const { gateRequested, exitCode } = record;

  const known = new Map(criteria.map((c) => [c.id, c]));
  const byCriterion = record.summary.byCriterion;
  const ids = [
    ...criteria.filter((c) => c.enabled !== false || c.id in byCriterion).map((c) => c.id),
    ...Object.keys(byCriterion).filter((id) => !known.has(id)),
  ];
  const rows: ReportCriterionRow[] = ids.map((id) => {
    const criterion = known.get(id);
    const counts = byCriterion[id];
    const type = criterion?.type ?? 'unknown';
    const threshold = lock?.criteria[id]?.threshold;
    return {
      id: r(id),
      type,
      wording: criterion === undefined ? NOT_IN_CRITERIA : r(criterion.instructions),
      passed: counts?.passed ?? 0,
      failed: counts?.failed ?? 0,
      unscored: counts?.unscored ?? 0,
      calibration: rowCalibration(type, lock, id),
      ...(threshold === undefined || type === 'score' ? {} : { threshold }),
    };
  });

  const gateable = criteria.filter(isGateable);
  const calibrated = gateable.filter((c) => lock?.criteria[c.id]?.status === 'calibrated').length;
  const gateWord = gateRequested ? 'on' : 'off';
  const label = demo
    ? 'demo · uncalibrated'
    : calibrated === 0
      ? 'uncalibrated'
      : `${String(calibrated)}/${String(gateable.length)} calibrated, gate ${gateWord}`;
  const badgeState = demo
    ? 'demo'
    : calibrated === 0
      ? 'uncalibrated'
      : `${String(calibrated)}/${String(gateable.length)} calibrated`;

  const failedCases = [
    ...new Set(
      record.results
        .filter((v) => v.status === 'ok' && v.pass !== true && v.gated !== false)
        .map((v) => r(v.caseId)),
    ),
  ].toSorted();

  const caseRows =
    includeCases && cases !== undefined
      ? cases.map((c): ReportCaseRow => {
          const own = record.results.filter((v) => v.caseId === c.id);
          return {
            id: r(c.id),
            outcome: caseOutcome(own),
            state: cap(r(c.input.state)),
          };
        })
      : undefined;

  const { pinned } = record.model;
  return {
    demo,
    counts: {
      total: record.summary.total,
      passed: record.summary.passed,
      failed: record.summary.failed,
      unscored: record.summary.unscored,
      aborted: record.summary.aborted,
      exitCode,
    },
    calibration: { calibrated, gateable: gateable.length, gateRequested, label },
    gateReasons: record.gateReasons.map(r),
    model: {
      name: r(record.model.resolved === '' ? record.model.requested : record.model.resolved),
      transport: r(record.model.transport),
      pinned,
      ...(pinned ? {} : { pinnedNote: PINNED_NOTE }),
    },
    criteria: rows,
    failedCases,
    ...(caseRows === undefined ? {} : { cases: caseRows }),
    ...(cases === undefined ? {} : { datasetHash: datasetHash(cases) }),
    vetkitVersion,
    repoUrl: VETKIT_REPO_URL,
    startedAt: r(record.startedAt),
    badge: {
      schemaVersion: 1,
      label: 'vetkit',
      message: `${badgeState} · ${badgeResult(exitCode, gateRequested)}`,
      color: badgeColor(demo, exitCode, gateRequested, calibrated),
    },
  };
}

export interface ReportInputs {
  readonly criteria: Criterion[];
  readonly lock: Lock | null;
  readonly cases?: Case[];
  readonly warnings: string[];
}

/**
 * Reads what the model needs from disk: criteria.yaml, the lock and the cases directory, all
 * resolved against `rootDir`. Cases are always tried (for the dataset hash); an unloadable
 * cases directory is a warning, and an error only when case content was asked for.
 */
export async function loadReportInputs(input: {
  readonly rootDir: string;
  readonly record: RunRecord;
  readonly includeCases: boolean;
}): Promise<ReportInputs> {
  const { rootDir, record, includeCases } = input;
  const warnings: string[] = [];

  const criteriaPath = resolve(rootDir, record.criteriaPath);
  const loadedCriteria = await loadCriteria(criteriaPath);
  if (!loadedCriteria.ok) {
    warnings.push(
      `cannot read criteria from ${criteriaPath}: ${loadedCriteria.issues[0]?.message ?? 'unknown error'}`,
    );
  }
  const lock = await readLockOrNull(resolve(rootDir, LOCK_FILE));

  const casesPath = resolve(rootDir, record.casesPath);
  const loadedCases = await loadCases(casesPath);
  if (!loadedCases.ok) {
    const reason = loadedCases.issues[0]?.message ?? 'unknown error';
    if (includeCases) {
      throw new VetError(
        CEV_ERROR_CODES.CASE_INVALID,
        `cannot load cases from ${casesPath}: ${reason}`,
      );
    }
    warnings.push(`cases unavailable at ${casesPath}: ${reason}`);
  }
  return {
    criteria: loadedCriteria.ok ? loadedCriteria.criteria : [],
    lock,
    ...(loadedCases.ok ? { cases: loadedCases.cases } : {}),
    warnings,
  };
}

export interface RenderMarkdownOptions {
  readonly maxFailedCases?: number;
  readonly maxCases?: number;
}

// One line of prose: newlines collapse and `<` is escaped, so user text can never open an HTML
// comment or a script tag in the Markdown.
function prose(text: string): string {
  return text.replaceAll(/\s+/g, ' ').replaceAll('<', '&lt;');
}

function cell(text: string): string {
  return prose(text).replaceAll('|', '\\|').replaceAll('`', "'");
}

function code(text: string): string {
  return `\`${cell(text)}\``;
}

/** Pure. Starts with an H3 (a comment or step summary supplies its own title above). */
export function renderMarkdown(model: ReportModel, opts: RenderMarkdownOptions = {}): string {
  const maxFailed = opts.maxFailedCases ?? 20;
  const maxCases = opts.maxCases ?? 50;
  const { counts, calibration } = model;
  const blocks: string[] = ['### vetkit eval report'];
  if (model.demo) {
    blocks.push(
      '> demo run — verdicts come from the built-in demo judge and are not a quality claim.',
    );
  }
  blocks.push(
    `**${String(counts.passed)} passed · ${String(counts.failed)} failed · ${String(counts.unscored)} unscored** of ${String(counts.total)}${counts.aborted ? ' (aborted)' : ''} · exit ${String(counts.exitCode)}`,
  );
  blocks.push(
    `Calibration: ${prose(calibration.label)}${calibration.label === 'uncalibrated' ? ' — run `vet validate` to calibrate thresholds' : ''}`,
  );
  const modelLines = [
    `Model: ${code(model.model.name)} (transport ${prose(model.model.transport)}, pinned: ${String(model.model.pinned)})`,
  ];
  if (model.model.pinnedNote !== undefined) modelLines.push(`_${prose(model.model.pinnedNote)}_`);
  blocks.push(modelLines.join('\n'));
  if (model.gateReasons.length > 0) {
    blocks.push(model.gateReasons.map((reason) => `Gate refused: ${prose(reason)}`).join('\n'));
  }
  blocks.push(
    [
      '| Criterion | Wording | Pass | Fail | Unscored | Calibration |',
      '| --- | --- | ---: | ---: | ---: | --- |',
      ...model.criteria.map(
        (c) =>
          `| ${code(c.id)} | ${cell(c.wording)} | ${String(c.passed)} | ${String(c.failed)} | ${String(c.unscored)} | ${cell(c.calibration)} |`,
      ),
    ].join('\n'),
  );
  if (model.failedCases.length > 0) {
    const shown = model.failedCases.slice(0, maxFailed).map(code).join(', ');
    const more = model.failedCases.length - maxFailed;
    blocks.push(`Failed cases: ${shown}${more > 0 ? ` (+${String(more)} more)` : ''}`);
  }
  if (model.cases !== undefined) {
    const rows = model.cases
      .slice(0, maxCases)
      .map((c) => `| ${code(c.id)} | ${c.outcome} | ${cell(c.state)} |`);
    const more = model.cases.length - maxCases;
    blocks.push(
      [
        `<details><summary>Cases (${String(model.cases.length)})</summary>`,
        '',
        '| Case | Outcome | State |',
        '| --- | --- | --- |',
        ...rows,
        ...(more > 0 ? ['', `(+${String(more)} more)`] : []),
        '',
        '</details>',
      ].join('\n'),
    );
  }
  blocks.push(
    `Dataset \`${model.datasetHash ?? 'unavailable'}\` · vetkit ${prose(model.vetkitVersion)} · started ${prose(model.startedAt)} · [vetkit](${model.repoUrl})`,
  );
  return `${blocks.join('\n\n')}\n`;
}
