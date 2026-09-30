// `vet rerun`: re-judges only the verdicts from the last `vet run` that
// are disputed: borderline (|value - threshold| <= the lock's tolerance, already
// computed by run.ts decide() as RunVerdict.borderline) or a judge failure (status 'unscored',
// 'error' or 'infra_failure') — bypassing the cache for exactly those case ids (runJudge), and writes a new latest run plus a --json run-to-run comparison.
// A missing run record exits 2 with RUN_NOT_FOUND; an empty disputed set exits 0 and changes
// nothing (`vet run` owns a full re-run).
import { resolve } from 'node:path';
import {
  clusterKeys,
  correctedPassRate,
  decideExit,
  loadCases,
  loadCriteria,
  LOCK_FILE,
  pairedClusteredDiff,
  readLockOrNull,
  readRunRecord,
  runJudge,
  writeRunRecord,
  type CorrectedPassRateResult,
  type PairedClusteredDiffResult,
  type RunRecord,
  type RunSummary,
  type RunVerdict,
  type Saturation,
} from '@vetkit/core';
import {
  CEV_ERROR_CODES,
  VetError,
  type Case,
  type Criterion,
  type Lock,
  type Verdict,
} from '@vetkit/spec';
import type { Command } from 'commander';
import { loadVetConfig } from '../config-load.ts';
import { emit, getLogger, type GlobalOptions } from '../output.ts';
import type { ValidateDeps } from './validate.ts';

interface RerunOptions extends GlobalOptions {
  readonly config?: string;
}

type Outcome = 'passed' | 'failed' | 'unscored' | 'neutral';

function outcomeOf(v: RunVerdict): Outcome {
  if (v.status === 'not_applicable') return 'neutral';
  if (v.status !== 'ok') return 'unscored';
  return v.pass === true ? 'passed' : 'failed';
}

// Same shape run.ts's runEvals writes into a RunRecord; duplicated here (that summarising
// function isn't exported by core).
function summarise(
  cases: readonly Case[],
  criteria: readonly Criterion[],
  verdicts: readonly RunVerdict[],
): RunSummary {
  const byCriterion: RunSummary['byCriterion'] = {};
  let passed = 0;
  let failed = 0;
  let unscored = 0;
  for (const evalCase of cases) {
    const outcomes = verdicts.filter((v) => v.caseId === evalCase.id).map(outcomeOf);
    if (outcomes.includes('failed')) failed += 1;
    else if (outcomes.includes('unscored')) unscored += 1;
    else passed += 1;
  }
  for (const criterion of criteria) {
    const outcomes = verdicts.filter((v) => v.criterionId === criterion.id).map(outcomeOf);
    const cPassed = outcomes.filter((o) => o === 'passed').length;
    const cFailed = outcomes.filter((o) => o === 'failed').length;
    let saturated: Saturation = null;
    if (cPassed + cFailed > 0) {
      if (cFailed === 0) saturated = 'all_pass';
      else if (cPassed === 0) saturated = 'all_fail';
    }
    byCriterion[criterion.id] = {
      total: outcomes.length,
      passed: cPassed,
      failed: cFailed,
      unscored: outcomes.filter((o) => o === 'unscored').length,
      saturated,
    };
  }
  return { total: cases.length, passed, failed, unscored, aborted: false, byCriterion };
}

function pickModel(verdicts: readonly RunVerdict[], fallback: Verdict['model']): Verdict['model'] {
  const judged = verdicts.find((v) => v.model.transport !== 'code' && v.model.resolved !== '');
  return judged?.model ?? fallback;
}

/** Borderline (computed against the lock at judge time) or a judge failure. */
function isDisputed(v: RunVerdict, hasLock: boolean): boolean {
  if (v.status === 'infra_failure' || v.status === 'error' || v.status === 'unscored') return true;
  if (v.status !== 'ok') return false; // not_applicable (escape/disabled): never disputed
  if (hasLock) return v.borderline === true;
  // No lock: the tolerance band collapses to 0 (run.ts decide()), so fall back to the judge's
  // own stated confidence (choice/score answers only; boolean answers carry none).
  const confidence = v.answer?.confidence;
  return typeof confidence === 'number' && confidence < 0.5;
}

/** A rejudge that still failed keeps the previous verdict, remarked infra_failure. */
function mergeVerdict(previous: RunVerdict, rejudged: RunVerdict): RunVerdict {
  if (rejudged.status === 'ok' || rejudged.status === 'not_applicable') return rejudged;
  return { ...previous, status: 'infra_failure', cause: rejudged.cause };
}

// Same as run.ts's own loadError (not exported).
function loadError(
  code: VetError['code'],
  source: string,
  issues: readonly { readonly message: string }[],
): VetError {
  const detail = issues.map((i) => i.message).join('; ');
  return new VetError(code, `cannot load ${source}: ${detail}`);
}

function passValue(v: RunVerdict): number | undefined {
  return v.pass === undefined ? undefined : v.pass ? 1 : 0;
}

/** Rogan-Gladen point estimate reconstructed from the lock's tpr/tnr and labelCount (no raw
 * held-out confusion counts are stored in the lock, so the bootstrap CI uses an even class split
 * of labelCount as a stand-in sample size — an approximation, not the real held-out n). */
function lockCorrectedPassRate(
  lock: Lock | null,
  criterionId: string,
  observedPasses: number,
  observedN: number,
): CorrectedPassRateResult | undefined {
  const entry = lock?.criteria[criterionId];
  if (entry?.tpr === undefined || entry.tnr === undefined || observedN === 0) return undefined;
  const nPos = Math.max(1, Math.round(entry.labelCount / 2));
  const nNeg = Math.max(1, entry.labelCount - nPos);
  const tp = Math.round(entry.tpr * nPos);
  const tn = Math.round(entry.tnr * nNeg);
  return correctedPassRate({
    observedPasses,
    observedN,
    heldOut: { tp, fn: nPos - tp, tn, fp: nNeg - tn },
    seed: 0,
  });
}

interface CriterionComparison extends PairedClusteredDiffResult {
  readonly correctedPassRate?: {
    readonly new: CorrectedPassRateResult;
    readonly previous: CorrectedPassRateResult;
  };
}

function buildComparison(
  criteria: readonly Criterion[],
  cases: readonly Case[],
  previous: readonly RunVerdict[],
  current: readonly RunVerdict[],
  lock: Lock | null,
): Record<string, CriterionComparison> {
  const keys = clusterKeys(cases);
  const out: Record<string, CriterionComparison> = {};
  for (const criterion of criteria) {
    if (criterion.grader?.kind === 'code') continue;
    const prevMap = new Map<string, number>();
    for (const v of previous) {
      if (v.criterionId !== criterion.id) continue;
      const value = passValue(v);
      if (value !== undefined) prevMap.set(v.caseId, value);
    }
    const curMap = new Map<string, number>();
    let curPasses = 0;
    let curN = 0;
    for (const v of current) {
      if (v.criterionId !== criterion.id) continue;
      const value = passValue(v);
      if (value === undefined) continue;
      curMap.set(v.caseId, value);
      curN += 1;
      curPasses += value;
    }
    let prevPasses = 0;
    let prevN = 0;
    for (const value of prevMap.values()) {
      prevN += 1;
      prevPasses += value;
    }
    const diff = pairedClusteredDiff(curMap, prevMap, keys);
    const newRate = lockCorrectedPassRate(lock, criterion.id, curPasses, curN);
    const previousRate = lockCorrectedPassRate(lock, criterion.id, prevPasses, prevN);
    out[criterion.id] =
      newRate === undefined || previousRate === undefined
        ? diff
        : { ...diff, correctedPassRate: { new: newRate, previous: previousRate } };
  }
  return out;
}

async function rerunCommand(options: RerunOptions, deps: ValidateDeps): Promise<void> {
  const log = getLogger();
  const load = deps.loadConfig ?? loadVetConfig;
  const loaded = await load({
    cwd: process.cwd(),
    ...(options.config === undefined ? {} : { configPath: options.config }),
  });
  for (const warning of loaded.warnings) log.warn(warning);
  const { config, rootDir, judge } = loaded;
  const cacheDir = resolve(rootDir, config.cacheDir);

  const previousRecord = await readRunRecord(cacheDir);
  if (previousRecord === null) {
    throw new VetError(
      CEV_ERROR_CODES.RUN_NOT_FOUND,
      `no run record at ${resolve(cacheDir, 'runs', 'latest.json')}; run \`vet run\` first`,
    );
  }
  const lock = await readLockOrNull(resolve(rootDir, LOCK_FILE));
  if (lock === null) log.warn('no lock: treating verdicts with confidence < 0.5 as disputed');

  const disputedIds = new Set(
    previousRecord.results.filter((v) => isDisputed(v, lock !== null)).map((v) => v.caseId),
  );
  if (disputedIds.size === 0) {
    emit({ disputed: 0 }, () => 'nothing to rerun');
    process.exitCode = 0;
    return;
  }

  const criteriaPath = resolve(rootDir, previousRecord.criteriaPath);
  const casesPath = resolve(rootDir, previousRecord.casesPath);
  const loadedCriteria = await loadCriteria(criteriaPath);
  if (!loadedCriteria.ok) {
    const code = loadedCriteria.issues[0]?.code ?? CEV_ERROR_CODES.CRITERIA_INVALID;
    throw loadError(code, criteriaPath, loadedCriteria.issues);
  }
  const loadedCases = await loadCases(casesPath);
  if (!loadedCases.ok) {
    const code = loadedCases.issues[0]?.code ?? CEV_ERROR_CODES.CASE_INVALID;
    throw loadError(code, casesPath, loadedCases.issues);
  }
  const { criteria } = loadedCriteria;
  const { cases } = loadedCases;
  const active = criteria.filter((c) => c.enabled !== false);
  const disabledIds = new Set(criteria.filter((c) => c.enabled === false).map((c) => c.id));
  const subset = cases.filter((c) => disputedIds.has(c.id));

  const rejudged = await runJudge({
    cases: subset,
    criteria: active,
    judge,
    lock,
    bypassCache: true,
    threshold: config.thresholds.default,
  });

  const previousByKey = new Map(
    previousRecord.results.map((v) => [`${v.caseId}:${v.criterionId}`, v]),
  );
  const merged = rejudged.map((v) => {
    const prev = previousByKey.get(`${v.caseId}:${v.criterionId}`);
    return prev === undefined ? v : mergeVerdict(prev, v);
  });
  const carried = previousRecord.results.filter(
    (v) => !disputedIds.has(v.caseId) || disabledIds.has(v.criterionId),
  );
  const results = [...carried, ...merged];

  const summary = summarise(cases, criteria, results);
  const fallbackModel: Verdict['model'] = {
    requested: judge.capabilities.model,
    resolved: '',
    transport: judge.capabilities.transport,
    pinned: judge.capabilities.pinned,
  };
  const model = pickModel(results, fallbackModel);
  const exitCode = decideExit({ verdicts: results });
  const startedAt = new Date().toISOString();
  const record: Omit<RunRecord, '$schema' | 'schemaVersion' | 'gateRequested'> = {
    results,
    summary,
    model,
    exitCode,
    gateReasons: [],
    criteriaPath: previousRecord.criteriaPath,
    casesPath: previousRecord.casesPath,
    startedAt,
  };
  // rerun never gates; the record-only fields ($schema, schemaVersion, gateRequested) stay out of the --json document.
  await writeRunRecord(cacheDir, { ...record, gateRequested: false });

  const comparison = buildComparison(criteria, cases, previousRecord.results, results, lock);
  const lines = [
    `rerun: ${String(disputedIds.size)} disputed case(s), ${String(rejudged.length)} verdict(s) rejudged`,
    `${String(summary.passed)} passed, ${String(summary.failed)} failed, ${String(summary.unscored)} unscored of ${String(summary.total)}`,
  ];
  emit({ ...record, comparison }, () => lines.join('\n'));
  process.exitCode = exitCode;
}

export function registerRerun(program: Command, deps: ValidateDeps = {}): Command {
  return program
    .command('rerun')
    .description('re-judge the disputed verdicts (borderline or judge failure) of the last vet run')
    .option('--config <path>', 'config file (default: vetkit.config.* in the current directory)')
    .action(async (_options: unknown, command: Command) => {
      await rerunCommand(command.optsWithGlobals<RerunOptions>(), deps);
    });
}
