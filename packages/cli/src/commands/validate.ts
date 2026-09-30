// `vet validate`. validate judges every labelled case
// `--repeats` times (min 3) with the cache bypassed, tops the band cases up to 15 repeats,
// calibrates, runs the eight gauntlets on the held-out cases and writes criteria.lock.json
// atomically. `vet check` lives in check.ts and reuses loadProject.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  bandCases,
  buildLock,
  type LockCriterionInput,
  flippedFamilies,
  masterKeyFailures,
  calibrate,
  correctedPassRate,
  createEvents,
  DEFAULT_GAUNTLET_CORPORA,
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
  readLockOrNull,
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
  type Unscored,
  unscoredOf,
} from '@vetkit/core';
import {
  CEV_ERROR_CODES,
  DEFAULT_REQUEST_FORMAT,
  safeParseJson,
  VetError,
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
import {
  loadVetConfig,
  projectPaths,
  type LoadedVetConfig,
  type LoadVetConfigOptions,
  type ProjectPaths,
} from '../config-load.ts';
import { generatorFromEndpoint } from '../generators.ts';
import { emit, getLogger, type GlobalOptions } from '../output.ts';
import { renderEvents } from '../render-events.ts';

const MIN_REPEATS = 3;
const MAX_REPEATS = 15;
const MIN_LABELS = 100;
const SEED = 0;

export interface ValidateDeps {
  /** Config loader; defaults to the CLI's shared loadVetConfig. */
  readonly loadConfig?: (options: LoadVetConfigOptions) => Promise<LoadedProject>;
  /** Event bus; defaults to a fresh one rendered on stderr. */
  readonly events?: Events;
}

/** What loadProject needs from a loaded config; `paths` is derived from rootDir when a loader omits it. */
type LoadedProject = Pick<LoadedVetConfig, 'config' | 'judge' | 'rootDir' | 'warnings'> &
  Partial<Pick<LoadedVetConfig, 'paths'>>;

export interface ProjectOptions extends GlobalOptions {
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

export interface Project {
  readonly loaded: LoadedProject;
  readonly paths: ProjectPaths;
  readonly criteria: Criterion[];
  readonly cases: Case[];
}

interface LoadIssue {
  readonly message: string;
  readonly path?: string;
  readonly file?: string;
  readonly line?: number;
  readonly relatedPath?: string;
}

function loadError(code: VetError['code'], source: string, issues: readonly LoadIssue[]): VetError {
  const lines = issues.map((i) => {
    const where =
      i.file === undefined
        ? `${source}${i.path ?? ''}`
        : `${i.file}${i.line === undefined || i.line === 0 ? '' : `:${String(i.line)}`}`;
    const related = i.relatedPath === undefined ? '' : ` (also at ${i.relatedPath})`;
    return `${where}: ${i.message}${related}`;
  });
  return new VetError(code, [`cannot load ${source}:`, ...lines].join('\n'));
}

export async function loadProject(
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
  const paths = loaded.paths ?? projectPaths(loaded.rootDir, loaded.config.cacheDir);
  const criteriaPath = resolve(options.criteria ?? paths.criteria);
  const casesDir = resolve(options.cases ?? paths.cases);
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
  return { loaded, paths, criteria: criteria.criteria, cases: cases.cases };
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
  if ('kind' in generator) return generatorFromEndpoint(generator);
  return undefined;
}

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
  // A missing or empty corpus is skipped, never a pass.
  events.diag(
    'warn',
    'GAUNTLET_CORPUS_MISSING',
    `gauntlet corpus ${path} is missing or empty; that gauntlet is skipped`,
  );
  return undefined;
}

// `--gauntlet` omitted: the shipped corpora (packages/core/src/validate/corpora.ts)
// rather than an evals/gauntlet directory, so a fresh project gets real gauntlets out of the box.
// An explicit --gauntlet always wins; the conventional directory counts only when it exists.
function gauntletDir(options: ValidateOptions, paths: ProjectPaths): string | undefined {
  if (options.gauntlet !== undefined) return resolve(options.gauntlet);
  return existsSync(paths.gauntlet) ? paths.gauntlet : undefined;
}

async function loadCorpora(dir: string | undefined, events: Events): Promise<Corpora> {
  if (dir === undefined) {
    const { injections, masterKeys, constants, paddings } = DEFAULT_GAUNTLET_CORPORA;
    return { injections, masterKeys, constants, paddings };
  }
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

type Repeats = Map<string, JudgeResponse[]>;

function addRepeats(
  into: Repeats,
  criterion: Criterion,
  verdicts: readonly RunVerdict[],
  copies: number,
): void {
  for (const v of verdicts) {
    if (v.criterionId !== criterion.id || v.status !== 'ok' || v.answer === undefined) continue;
    const response: JudgeResponse = {
      answers: { [criterion.id]: v.answer },
      usage: { inputTokens: 0, outputTokens: 0 },
      model: v.model,
    };
    const list = into.get(v.caseId) ?? [];
    for (let i = 0; i < copies; i += 1) list.push(response);
    into.set(v.caseId, list);
  }
}

type GauntletMap = Record<keyof GauntletResult, GauntletOutcome>;

interface Detail {
  readonly paraphrase: { readonly agreement: number | null; readonly spread: number | null };
  readonly injection: {
    readonly families: Record<string, unknown>;
    readonly flipped: { family: string; flips: number; labelFlips: number; trials: number }[];
  };
  readonly master_key: {
    readonly failedInputs: { kind: string; caseId: string }[];
    readonly reason?: 'no_escape';
  };
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
  injection: { families: {}, flipped: [] },
  master_key: { failedInputs: [] },
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

async function runGauntlets(ctx: GauntletContext): Promise<{
  gauntlet: GauntletMap;
  detail: Detail;
  gauntletDetail: NonNullable<LockCriterionInput['gauntletDetail']>;
}> {
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
    gauntletDetail: {
      masterKeyFailedInputs: masterKey?.failedInputs ?? [],
      ...(masterKey?.reason === 'no_escape' ? { masterKeyReason: masterKey.reason } : {}),
      injectionFamilies: injection?.families ?? {},
    },
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
      injection: {
        families: injection?.families ?? {},
        flipped: flippedFamilies(injection?.families),
      },
      master_key: {
        failedInputs: masterKeyFailures(masterKey?.failedInputs ?? []),
        ...(masterKey?.reason === 'no_escape' ? { reason: masterKey.reason } : {}),
      },
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
  const { loaded, paths, criteria, cases } = project;
  const { judge } = loaded;
  // `enabled: false` (vet criteria disable): never judged or calibrated; the
  // lock carries no entry for it (mirrors runEvals' active/disabled split in run.ts).
  const active = criteria.filter((c) => c.enabled !== false);
  const disabled = criteria.filter((c) => c.enabled === false);
  const labelSet = await loadLabelSet(resolve(options.labels ?? paths.labels), project);
  const repeats = parseRepeats(options.repeats, events);
  const generator = await resolveGenerator(loaded.config.generator);
  const corpora = await loadCorpora(gauntletDir(options, paths), events);
  const lockPath = resolve(options.lock ?? paths.lock);
  const byId = new Map(cases.map((c) => [c.id, c]));

  const labelsOf = (c: Criterion): CalibrationLabel[] =>
    (labelSet.get(c.id) ?? []).map(({ caseId, label }) => ({ caseId, label }));
  const labelledIds = new Set(active.flatMap((c) => labelsOf(c).map((l) => l.caseId)));
  const labelledCases = cases.filter((c) => labelledIds.has(c.id));
  const judged = active.filter((c) => c.grader?.kind !== 'code');

  events.diag('info', 'VALIDATE_ESTIMATE', 'judge calls before top-up and gauntlets', {
    calls: judged.length === 0 ? 0 : labelledCases.length * repeats,
    cases: labelledCases.length,
    repeats,
  });
  events.diag('debug', 'VALIDATE_PHASE_CALIBRATION', 'validate: calibration');
  const verdicts = await runJudge({
    cases: labelledCases,
    criteria: active,
    judge,
    bypassCache: true,
    repeats,
    events,
  });

  const calibrated = new Map<string, { calibration: CalibrationResult; repeats: Repeats }>();
  for (const c of active) {
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
    {
      calibration: CalibrationResult;
      gauntlet: GauntletMap;
      detail: Detail;
      gauntletDetail: NonNullable<LockCriterionInput['gauntletDetail']>;
      unscored: Unscored;
    }
  > = {};
  for (const c of active) {
    const entry = calibrated.get(c.id);
    if (entry === undefined) continue;
    const { gauntlet, detail, gauntletDetail } =
      c.grader?.kind === 'code'
        ? { gauntlet: SKIPPED_ALL, detail: EMPTY_DETAIL, gauntletDetail: {} }
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
    results[c.id] = {
      calibration: entry.calibration,
      gauntlet,
      detail,
      gauntletDetail,
      unscored: unscoredOf(c.id, verdicts),
    };
  }

  const lock = buildLock({
    model: runModel(verdicts, judge),
    criteria: active,
    cases,
    results,
    requestFormat: judge.capabilities.requestFormat ?? DEFAULT_REQUEST_FORMAT,
  });
  // buildLock only sees `active`, so a criterion turned off after being calibrated would
  // otherwise lose its lock entry; carry over its existing entry unchanged instead.
  if (disabled.length > 0) {
    const previous = await readLockOrNull(lockPath);
    for (const c of disabled) {
      const prior = previous?.criteria[c.id];
      if (prior !== undefined) lock.criteria[c.id] = prior;
    }
  }
  // Fewer than 100 labels per judged criterion is a refusal; it must not create or
  // overwrite criteria.lock.json (an empty/stale lock would otherwise let `vet run` proceed unchecked).
  const short = judged
    .map((c) => ({ id: c.id, n: labelsOf(c).length }))
    .filter(({ n }) => n < MIN_LABELS);
  if (short.length === 0) {
    await writeLockAtomic(lockPath, lock, { events, since });
  }

  const report = {
    criteria: active.map((c) => {
      const r = results[c.id];
      const e = lock.criteria[c.id];
      const cal = r?.calibration;
      const reps = calibrated.get(c.id)?.repeats ?? new Map();
      const unscored = unscoredOf(c.id, verdicts);
      return {
        id: c.id,
        status: e?.status,
        reasons: e?.reasons ?? [],
        unscored,
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
  // Under --json the LABELS_TOO_FEW error document below is the only stdout document.
  if (!(options.json === true && short.length > 0)) {
    emit(report, () =>
      [
        ...report.criteria.map(
          (c) =>
            `${c.id}: ${String(c.status)}${c.reasons.length === 0 ? '' : ` (${c.reasons.join(', ')})`}`,
        ),
        short.length === 0
          ? `lock written: ${lockPath}`
          : `refusing to write ${lockPath} (too few labels)`,
      ].join('\n'),
    );
  }

  // Fewer than 100 labels per judged criterion exits 2 with the count.
  if (short.length > 0) {
    throw new VetError(
      CEV_ERROR_CODES.LABELS_TOO_FEW,
      short
        .map(({ id, n }) => `${id}: ${String(n)} labels (need ${String(MIN_LABELS)})`)
        .join('; '),
    );
  }
}

export function registerValidate(program: Command, deps: ValidateDeps = {}): Command {
  program
    .command('validate')
    .description('calibrate every criterion against human labels and write criteria.lock.json')
    .option('--config <path>', 'config file (default: vetkit.config.* in the current directory)')
    .option(
      '--criteria <file>',
      'criteria file (default: criteria.yaml next to the config, or under evals/ when that directory exists)',
    )
    .option(
      '--cases <dir>',
      'cases directory (default: cases next to the config, or under evals/ when that directory exists)',
    )
    .option(
      '--labels <dir>',
      'labels directory (default: labels next to the config, or under evals/ when that directory exists)',
    )
    .option('--repeats <n>', 'judge each labelled case n times (default and minimum 3)')
    .option('--lock <path>', 'lock file to write (default: criteria.lock.json next to the config)')
    .option(
      '--gauntlet <dir>',
      'gauntlet corpora directory (default: gauntlet next to the config, or under evals/ when that directory exists)',
    )
    .action(async (_options: unknown, command: Command) => {
      await validateCommand(command.optsWithGlobals<ValidateOptions>(), deps);
    });
  return program;
}
