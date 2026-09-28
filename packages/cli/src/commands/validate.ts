// `vet validate` and `vet check --lock` (bead mol-q4q.6; docs/contracts/j3.md). validate judges
// every labelled case `--repeats` times (min 3) with the cache bypassed, tops the band cases up to
// 15 repeats, calibrates, runs the eight gauntlets on the held-out cases and writes
// criteria.lock.json atomically. check recomputes the lock's content hashes and compares the
// judge's transport and release date; it exits 1 when stale and 2 when the lock is missing.
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  bandCases,
  buildLock,
  calibrate,
  checkLock,
  correctedPassRate,
  createEvents,
  gauntletConstantOutput,
  gauntletInjection,
  gauntletLabelPermutation,
  gauntletLength,
  gauntletMasterKey,
  gauntletParaphrase,
  gauntletPolarity,
  gauntletPositionSwap,
  loadCases,
  loadCriteria,
  loadLabels,
  LOCK_FILE,
  readLock,
  repeatValues,
  runJudge,
  writeLockAtomic,
  type CalibrationLabel,
  type CalibrationResult,
  type ConstantEntry,
  type CorrectedPassRateResult,
  type Events,
  type InjectionEntry,
  type LabelSet,
  type MasterKeyEntry,
  type PaddingTemplate,
  type ResolvedConfig,
  type RunVerdict,
} from '@vetkit/core';
import {
  CEV_ERROR_CODES,
  safeParseJson,
  VetError,
  type Answer,
  type Case,
  type Criterion,
  type GauntletOutcome,
  type GauntletResult,
  type GeneratorV1,
  type JsonSchema,
  type JudgeResponse,
  type JudgeV1,
} from '@vetkit/spec';
import type { Command } from 'commander';
import { loadVetConfig, type LoadedVetConfig, type LoadVetConfigOptions } from '../config-load.ts';
import { emit, getLogger, type GlobalOptions } from '../output.ts';
import { renderEvents } from '../render-events.ts';

const MIN_REPEATS = 3;
const MAX_REPEATS = 15;
const MIN_LABELS = 100;
const SEED = 0;

export interface ValidateDeps {
  /** Config loader; defaults to the CLI's shared loadVetConfig. */
  readonly loadConfig?: (
    options: LoadVetConfigOptions,
  ) => Promise<Pick<LoadedVetConfig, 'config' | 'judge' | 'rootDir' | 'warnings'>>;
  /** Event bus; defaults to a fresh one rendered on stderr. */
  readonly events?: Events;
}

interface ProjectOptions extends GlobalOptions {
  readonly config?: string;
  readonly criteria?: string;
  readonly cases?: string;
}

interface ValidateOptions extends ProjectOptions {
  readonly labels?: string;
  readonly repeats?: string;
  readonly lock?: string;
  readonly gauntlet?: string;
}

interface CheckOptions extends ProjectOptions {
  readonly lock?: string | boolean;
}

interface Project {
  readonly loaded: Pick<LoadedVetConfig, 'config' | 'judge' | 'rootDir' | 'warnings'>;
  readonly criteria: Criterion[];
  readonly cases: Case[];
}

function loadError(
  code: VetError['code'],
  source: string,
  issues: readonly { message: string }[],
): VetError {
  return new VetError(code, `cannot load ${source}: ${issues.map((i) => i.message).join('; ')}`);
}

async function loadProject(
  options: ProjectOptions,
  deps: ValidateDeps,
  requireCredentials: boolean,
): Promise<Project> {
  const load = deps.loadConfig ?? loadVetConfig;
  const loaded = await load({
    cwd: process.cwd(),
    requireCredentials,
    ...(options.config === undefined ? {} : { configPath: options.config }),
  });
  for (const warning of loaded.warnings) getLogger().warn(warning);
  const criteriaPath = resolve(options.criteria ?? join(loaded.rootDir, 'evals/criteria.yaml'));
  const casesDir = resolve(options.cases ?? join(loaded.rootDir, 'evals/cases'));
  const criteria = await loadCriteria(criteriaPath);
  if (!criteria.ok) {
    const code = criteria.issues[0]?.code ?? CEV_ERROR_CODES.CRITERIA_INVALID;
    throw loadError(code, criteriaPath, criteria.issues);
  }
  const cases = await loadCases(casesDir);
  if (!cases.ok) {
    const code = cases.issues[0]?.code ?? CEV_ERROR_CODES.CASE_INVALID;
    throw loadError(code, casesDir, cases.issues);
  }
  return { loaded, criteria: criteria.criteria, cases: cases.cases };
}

async function exists(path: string): Promise<boolean> {
  return readFile(path).then(
    () => true,
    () => false,
  );
}

async function loadLabelSet(dir: string, project: Project): Promise<LabelSet> {
  const result = await loadLabels(dir, {
    caseIds: new Set(project.cases.map((c) => c.id)),
    criterionIds: new Set(project.criteria.map((c) => c.id)),
  });
  if (result.ok) return result.labels;
  // No labels directory yet: every criterion has 0 labels (LABELS_TOO_FEW after the lock).
  const first = result.issues[0];
  if (first?.code === CEV_ERROR_CODES.E_IO && !(await exists(dir))) return new Map();
  throw new VetError(
    first?.code ?? CEV_ERROR_CODES.LABELS_INVALID,
    result.issues.map((i) => `${i.file}:${String(i.line)}: ${i.message}`).join('\n'),
  );
}

function parseRepeats(raw: string | undefined, events: Events): number {
  if (raw === undefined) return MIN_REPEATS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new VetError(
      CEV_ERROR_CODES.CONFIG_INVALID,
      `--repeats must be a positive integer, got '${raw}'`,
    );
  }
  if (n < MIN_REPEATS) {
    events.diag(
      'warn',
      'REPEATS_RAISED',
      `--repeats ${raw} is below ${String(MIN_REPEATS)}; using ${String(MIN_REPEATS)}`,
      {
        requested: n,
        used: MIN_REPEATS,
      },
    );
    return MIN_REPEATS;
  }
  return n;
}

// ---------- generator ----------

function isGenerator(value: unknown): value is GeneratorV1 {
  return (
    typeof value === 'object' &&
    value !== null &&
    'doGenerate' in value &&
    typeof value.doGenerate === 'function'
  );
}

async function resolveGenerator(
  generator: ResolvedConfig['generator'],
): Promise<GeneratorV1 | undefined> {
  if (generator === undefined) return undefined;
  if (isGenerator(generator)) return generator;
  // Loaded lazily: only a config with a generator endpoint needs the adapter package.
  const { generatorFromEndpoint } = await import('../generators.ts');
  if ('kind' in generator) return generatorFromEndpoint(generator);
  return undefined;
}

// ---------- gauntlet corpora ----------

interface Corpora {
  readonly injections?: readonly InjectionEntry[];
  readonly masterKeys?: readonly MasterKeyEntry[];
  readonly constants?: readonly ConstantEntry[];
  readonly paddings?: readonly PaddingTemplate[];
}

function corpusSchema(key: string): JsonSchema {
  return {
    type: 'object',
    required: [key],
    properties: {
      [key]: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'text'],
          properties: { id: { type: 'string' }, text: { type: 'string' } },
        },
      },
    },
  };
}

async function readCorpus<T>(
  dir: string,
  file: string,
  key: string,
  events: Events,
): Promise<readonly T[] | undefined> {
  const path = join(dir, file);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    text = '';
  }
  if (text !== '') {
    const parsed = safeParseJson<Record<string, T[]>>(text, corpusSchema(key));
    if (!parsed.ok) {
      throw new VetError(
        parsed.error.code,
        `invalid gauntlet corpus ${path}: ${parsed.error.message}`,
      );
    }
    const entries = parsed.value[key] ?? [];
    if (entries.length > 0) return entries;
  }
  // A missing or empty corpus is skipped, never a pass (review revision 1).
  events.diag(
    'warn',
    'GAUNTLET_CORPUS_MISSING',
    `gauntlet corpus ${path} is missing or empty; that gauntlet is skipped`,
  );
  return undefined;
}

async function loadCorpora(dir: string, events: Events): Promise<Corpora> {
  const injections = await readCorpus<InjectionEntry>(dir, 'injections.json', 'injections', events);
  const masterKeys = await readCorpus<MasterKeyEntry>(dir, 'master-keys.json', 'inputs', events);
  const constants = await readCorpus<ConstantEntry>(
    dir,
    'constant-outputs.json',
    'constants',
    events,
  );
  const paddings = await readCorpus<PaddingTemplate>(dir, 'padding.json', 'paddings', events);
  return {
    ...(injections === undefined ? {} : { injections }),
    ...(masterKeys === undefined ? {} : { masterKeys }),
    ...(constants === undefined ? {} : { constants }),
    ...(paddings === undefined ? {} : { paddings }),
  };
}

// ---------- repeats ----------

type Repeats = Map<string, JudgeResponse[]>;

// Boolean criteria are asked as a {yes, no, escape} choice; calibrate reads P(yes) as a boolean.
function calibrationAnswer(criterion: Criterion, answer: Answer): Answer {
  if (criterion.type === 'boolean' && answer.type === 'choice') {
    return { type: 'boolean', probability: answer.probabilities['yes'] ?? 0 };
  }
  return answer;
}

function addRepeats(
  into: Repeats,
  criterion: Criterion,
  verdicts: readonly RunVerdict[],
  copies: number,
): void {
  for (const v of verdicts) {
    if (v.criterionId !== criterion.id || v.status !== 'ok' || v.answer === undefined) continue;
    const response: JudgeResponse = {
      answers: { [criterion.id]: calibrationAnswer(criterion, v.answer) },
      usage: { inputTokens: 0, outputTokens: 0 },
      model: v.model,
    };
    const list = into.get(v.caseId) ?? [];
    for (let i = 0; i < copies; i += 1) list.push(response);
    into.set(v.caseId, list);
  }
}

// ---------- gauntlets ----------

type GauntletMap = Record<keyof GauntletResult, GauntletOutcome>;

interface Detail {
  readonly paraphrase: { readonly agreement: number | null; readonly spread: number | null };
  readonly injection: { readonly families: Record<string, unknown> };
  readonly position_swap: {
    readonly consistency: number | null;
    readonly inconclusive: number | null;
  };
  readonly length: {
    readonly paddingFlips: number;
    readonly truncationFlips: number;
    readonly lengthVerdictCorrelation: number | null;
  };
}

const SKIPPED_ALL: GauntletMap = {
  paraphrase: 'skipped',
  polarity: 'skipped',
  injection: 'skipped',
  master_key: 'skipped',
  label_permutation: 'skipped',
  constant_output: 'skipped',
  position_swap: 'skipped',
  length: 'skipped',
};

const EMPTY_DETAIL: Detail = {
  paraphrase: { agreement: null, spread: null },
  injection: { families: {} },
  position_swap: { consistency: null, inconclusive: null },
  length: { paddingFlips: 0, truncationFlips: 0, lengthVerdictCorrelation: null },
};

interface GauntletContext {
  readonly criterion: Criterion;
  readonly calibration: CalibrationResult;
  readonly labels: readonly CalibrationLabel[];
  readonly repeats: Repeats;
  readonly cases: ReadonlyMap<string, Case>;
  readonly judge: JudgeV1;
  readonly generator: GeneratorV1 | undefined;
  readonly corpora: Corpora;
}

async function runGauntlets(
  ctx: GauntletContext,
): Promise<{ gauntlet: GauntletMap; detail: Detail }> {
  const { criterion, calibration, labels, judge, generator, corpora } = ctx;
  const pick = (ids: readonly string[]): Case[] =>
    ids.flatMap((id) => {
      const c = ctx.cases.get(id);
      return c === undefined ? [] : [c];
    });
  const sample = pick(calibration.split.heldOut);
  const heldOut = new Set(calibration.split.heldOut);
  const labelled = (label: 'pass' | 'fail'): Case[] =>
    pick(labels.filter((l) => l.label === label && heldOut.has(l.caseId)).map((l) => l.caseId));
  const knownPass = labelled('pass');
  const knownFail = labelled('fail');
  const threshold = calibration.threshold === undefined ? {} : { threshold: calibration.threshold };

  const paraphrase = await gauntletParaphrase(criterion, sample, generator, judge, threshold);
  const polarity = await gauntletPolarity(criterion, sample, labels, generator, judge, threshold);
  const injection =
    corpora.injections === undefined
      ? undefined
      : await gauntletInjection(criterion, sample, judge, {
          injections: corpora.injections,
          ...threshold,
        });
  const masterKey =
    corpora.masterKeys === undefined
      ? undefined
      : await gauntletMasterKey(criterion, judge, knownPass, {
          inputs: corpora.masterKeys,
          ...threshold,
        });
  const permutation = gauntletLabelPermutation(
    labels,
    [...repeatValues(criterion, ctx.repeats)].flatMap(([caseId, values]) =>
      values.map((value) => ({ caseId, value })),
    ),
    { seed: SEED },
  );
  const constant =
    corpora.constants === undefined
      ? undefined
      : await gauntletConstantOutput(criterion, sample, judge, {
          constants: corpora.constants,
          ...threshold,
        });
  const swap = await gauntletPositionSwap(criterion, sample, judge, { seed: SEED });
  const length =
    corpora.paddings === undefined
      ? undefined
      : await gauntletLength(criterion, knownFail, knownPass, judge, {
          tolerance: calibration.tolerance ?? 0,
          paddings: corpora.paddings,
          ...threshold,
        });

  return {
    gauntlet: {
      paraphrase: paraphrase.result,
      polarity: polarity.result,
      injection: injection?.result ?? 'skipped',
      master_key: masterKey?.result ?? 'skipped',
      label_permutation: permutation.result,
      constant_output: constant?.result ?? 'skipped',
      position_swap: swap.result,
      length: length?.result ?? 'skipped',
    },
    detail: {
      paraphrase: {
        agreement: paraphrase.agreement.length === 0 ? null : Math.min(...paraphrase.agreement),
        spread: paraphrase.spread ?? null,
      },
      injection: { families: injection?.families ?? {} },
      position_swap: { consistency: swap.consistency, inconclusive: swap.inconclusive },
      length:
        length === undefined
          ? EMPTY_DETAIL.length
          : {
              paddingFlips: length.paddingFlips,
              truncationFlips: length.truncationFlips,
              lengthVerdictCorrelation: length.lengthVerdictCorrelation,
            },
    },
  };
}

// ---------- validate ----------

function correctedRate(
  criterion: Criterion,
  calibration: CalibrationResult,
  repeats: Repeats,
): CorrectedPassRateResult {
  const { threshold } = calibration;
  if (threshold === undefined) return { theta: null, ci95: null, valid: false };
  const means = [...repeatValues(criterion, repeats).values()]
    .filter((vs) => vs.length > 0)
    .map((vs) => vs.reduce((s, v) => s + v, 0) / vs.length);
  return correctedPassRate({
    observedPasses: means.filter((m) => m >= threshold).length,
    observedN: means.length,
    heldOut: calibration.heldOut,
    seed: SEED,
  });
}

function runModel(verdicts: readonly RunVerdict[], judge: JudgeV1): JudgeResponse['model'] {
  const judged = verdicts.find((v) => v.model.transport !== 'code' && v.model.resolved !== '');
  if (judged !== undefined) return judged.model;
  const { model, transport, pinned } = judge.capabilities;
  return { requested: model, resolved: '', transport, pinned };
}

async function validateCommand(options: ValidateOptions, deps: ValidateDeps): Promise<void> {
  const since = Date.now();
  const events = deps.events ?? createEvents();
  const stopRendering = renderEvents(events, { options });
  try {
    await validate(options, deps, events, since);
  } finally {
    stopRendering();
  }
}

async function validate(
  options: ValidateOptions,
  deps: ValidateDeps,
  events: Events,
  since: number,
): Promise<void> {
  const project = await loadProject(options, deps, true);
  const { loaded, criteria, cases } = project;
  const { judge, rootDir } = loaded;
  const labelSet = await loadLabelSet(
    resolve(options.labels ?? join(rootDir, 'evals/labels')),
    project,
  );
  const repeats = parseRepeats(options.repeats, events);
  const generator = await resolveGenerator(loaded.config.generator);
  const corpora = await loadCorpora(
    resolve(options.gauntlet ?? join(rootDir, 'evals/gauntlet')),
    events,
  );
  const lockPath = resolve(options.lock ?? join(rootDir, LOCK_FILE));
  const byId = new Map(cases.map((c) => [c.id, c]));

  const labelsOf = (c: Criterion): CalibrationLabel[] =>
    (labelSet.get(c.id) ?? []).map(({ caseId, label }) => ({ caseId, label }));
  const labelledIds = new Set(criteria.flatMap((c) => labelsOf(c).map((l) => l.caseId)));
  const labelledCases = cases.filter((c) => labelledIds.has(c.id));
  const judged = criteria.filter((c) => c.grader?.kind !== 'code');

  events.diag('info', 'VALIDATE_ESTIMATE', 'judge calls before top-up and gauntlets', {
    calls: judged.length === 0 ? 0 : labelledCases.length * repeats,
    cases: labelledCases.length,
    repeats,
  });
  events.diag('debug', 'VALIDATE_PHASE_CALIBRATION', 'validate: calibration');
  const verdicts = await runJudge({
    cases: labelledCases,
    criteria,
    judge,
    bypassCache: true,
    repeats,
    events,
  });

  const calibrated = new Map<string, { calibration: CalibrationResult; repeats: Repeats }>();
  for (const c of criteria) {
    const labels = labelsOf(c);
    const own = labelledCases.filter((k) => labels.some((l) => l.caseId === k.id));
    const reps: Repeats = new Map();
    // Code graders are deterministic: one verdict stands for every repeat.
    addRepeats(reps, c, verdicts, c.grader?.kind === 'code' ? repeats : 1);
    let calibration = calibrate(c, labels, reps, own, { seed: SEED });
    const { threshold, tolerance } = calibration;
    if (
      c.grader?.kind !== 'code' &&
      threshold !== undefined &&
      tolerance !== undefined &&
      repeats < MAX_REPEATS
    ) {
      const band = new Set(bandCases(repeatValues(c, reps), threshold, tolerance));
      if (band.size > 0) {
        const extra = await runJudge({
          cases: own.filter((k) => band.has(k.id)),
          criteria: [c],
          judge,
          bypassCache: true,
          repeats: MAX_REPEATS - repeats,
          events,
        });
        // A judge error leaves that repeat out, so the case keeps what it already had.
        addRepeats(reps, c, extra, 1);
        calibration = calibrate(c, labels, reps, own, { seed: SEED });
      }
    }
    calibrated.set(c.id, { calibration, repeats: reps });
  }

  events.diag('debug', 'VALIDATE_PHASE_GAUNTLET', 'validate: gauntlets');
  const results: Record<
    string,
    { calibration: CalibrationResult; gauntlet: GauntletMap; detail: Detail }
  > = {};
  for (const c of criteria) {
    const entry = calibrated.get(c.id);
    if (entry === undefined) continue;
    const { gauntlet, detail } =
      c.grader?.kind === 'code'
        ? { gauntlet: SKIPPED_ALL, detail: EMPTY_DETAIL }
        : await runGauntlets({
            criterion: c,
            calibration: entry.calibration,
            labels: labelsOf(c),
            repeats: entry.repeats,
            cases: byId,
            judge,
            generator,
            corpora,
          });
    results[c.id] = { calibration: entry.calibration, gauntlet, detail };
  }

  const lock = buildLock({ model: runModel(verdicts, judge), criteria, cases, results });
  await writeLockAtomic(lockPath, lock, { events, since });

  const report = {
    criteria: criteria.map((c) => {
      const r = results[c.id];
      const e = lock.criteria[c.id];
      const cal = r?.calibration;
      const reps = calibrated.get(c.id)?.repeats ?? new Map();
      return {
        id: c.id,
        status: e?.status,
        reasons: e?.reasons ?? [],
        languages: e?.languages ?? [],
        byLanguage: cal?.byLanguage ?? {},
        threshold: cal?.threshold ?? null,
        tpr: cal?.tpr ?? null,
        tnr: cal?.tnr ?? null,
        se: cal?.se ?? {},
        ece: cal?.ece ?? null,
        reliability: cal?.reliability ?? [],
        correctedPassRate:
          cal === undefined
            ? { theta: null, ci95: null, valid: false }
            : correctedRate(c, cal, reps),
        tolerance: cal?.tolerance ?? null,
        gauntlet: e?.gauntlet,
        detail: r?.detail ?? EMPTY_DETAIL,
      };
    }),
    model: lock.model,
    datasetHash: lock.datasetHash,
    lockPath,
  };
  emit(report, () =>
    [
      ...report.criteria.map(
        (c) =>
          `${c.id}: ${String(c.status)}${c.reasons.length === 0 ? '' : ` (${c.reasons.join(', ')})`}`,
      ),
      `lock written: ${lockPath}`,
    ].join('\n'),
  );

  // j3.md: fewer than 100 labels per judged criterion exits 2 with the count, after the lock.
  const short = judged
    .map((c) => ({ id: c.id, n: labelsOf(c).length }))
    .filter(({ n }) => n < MIN_LABELS);
  if (short.length > 0) {
    throw new VetError(
      CEV_ERROR_CODES.LABELS_TOO_FEW,
      short
        .map(({ id, n }) => `${id}: ${String(n)} labels (need ${String(MIN_LABELS)})`)
        .join('; '),
    );
  }
}

// ---------- check --lock ----------

async function describeReleaseDate(judge: JudgeV1): Promise<string | null> {
  const describe: unknown = Reflect.get(judge, 'describeModel');
  if (typeof describe !== 'function') return null;
  try {
    const described: unknown = await Reflect.apply(describe, judge, []);
    if (typeof described !== 'object' || described === null) return null;
    const date: unknown = Reflect.get(described, 'releaseDate');
    return typeof date === 'string' ? date : null;
  } catch {
    return null;
  }
}

async function checkCommand(options: CheckOptions, deps: ValidateDeps): Promise<void> {
  if (options.lock === undefined || options.lock === false) {
    throw new VetError(CEV_ERROR_CODES.CONFIG_INVALID, '`vet check` needs --lock [path]');
  }
  const project = await loadProject(options, deps, false);
  const { judge, rootDir } = project.loaded;
  const lockPath = resolve(
    typeof options.lock === 'string' ? options.lock : join(rootDir, LOCK_FILE),
  );
  const read = await readLock(lockPath);
  if ('error' in read) throw read.error;
  const report = checkLock(read, {
    criteria: project.criteria,
    cases: project.cases,
    model: {
      transport: judge.capabilities.transport,
      releaseDate: await describeReleaseDate(judge),
    },
  });
  emit(report, () =>
    report.stale
      ? `stale: ${report.reasons.join(', ')}`
      : `fresh: ${lockPath} matches the criteria and cases`,
  );
  // Root exit-code DECISION: stale exits 1 (LOCK_STALE), missing exits 2.
  if (report.stale) process.exitCode = 1;
}

export function registerValidate(program: Command, deps: ValidateDeps = {}): Command {
  program
    .command('validate')
    .description('calibrate every criterion against human labels and write criteria.lock.json')
    .option('--config <path>', 'config file (default: vetkit.config.* in the current directory)')
    .option('--criteria <file>', 'criteria file (default: evals/criteria.yaml next to the config)')
    .option('--cases <dir>', 'cases directory (default: evals/cases next to the config)')
    .option('--labels <dir>', 'labels directory (default: evals/labels next to the config)')
    .option('--repeats <n>', 'judge each labelled case n times (default and minimum 3)')
    .option('--lock <path>', 'lock file to write (default: criteria.lock.json next to the config)')
    .option(
      '--gauntlet <dir>',
      'gauntlet corpora directory (default: evals/gauntlet next to the config)',
    )
    .action(async (_options: unknown, command: Command) => {
      await validateCommand(command.optsWithGlobals<ValidateOptions>(), deps);
    });
  program
    .command('check')
    .description('check criteria.lock.json against the current criteria, cases and judge')
    .option('--lock [path]', 'lock file to check (default: criteria.lock.json next to the config)')
    .option('--config <path>', 'config file (default: vetkit.config.* in the current directory)')
    .option('--criteria <file>', 'criteria file (default: evals/criteria.yaml next to the config)')
    .option('--cases <dir>', 'cases directory (default: evals/cases next to the config)')
    .action(async (_options: unknown, command: Command) => {
      await checkCommand(command.optsWithGlobals<CheckOptions>(), deps);
    });
  return program;
}
