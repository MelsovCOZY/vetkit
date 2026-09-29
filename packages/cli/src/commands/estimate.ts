// `vet estimate [--for run|validate]`: judge calls, input tokens, cost and minutes before a run
// or a validate, with no network call (UX brief §5.3: a separate command, not --dry-run flags).
// The price row comes from the judge adapter's preset table for the resolved transport; a
// transport with no row (custom baseURL, in-process adapter) prints cost 'unknown'.
//
// --for validate: calibration uses core's exported CALIBRATION_MIN_REPEATS (the estimateValidate
// default). The gauntlet pack sizes depend on their input packs (paddings, injections,
// constants), so those parts print 'unknown' rather than a guess (bead AC).
import { resolve } from 'node:path';
import {
  estimateRun,
  estimateValidate,
  loadCases,
  loadCriteria,
  type CostEstimate,
  type EstimatePricing,
  type RunEstimate,
  type Unknowable,
  type ValidateEstimate,
} from '@vetkit/core';
import { JEV_PRESETS, type JevPresetName } from '@vetkit/judge-jev';
import { CEV_ERROR_CODES, VetError } from '@vetkit/spec';
import { Option, type Command } from 'commander';
import { loadVetConfig } from '../config-load.ts';
import { emit, getLogger, type GlobalOptions } from '../output.ts';

interface EstimateOptions extends GlobalOptions {
  readonly config?: string;
  readonly criteria?: string;
  readonly cases?: string;
  readonly for: 'run' | 'validate';
}

function isPreset(name: string): name is JevPresetName {
  return Object.hasOwn(JEV_PRESETS, name);
}

function pricingFor(transport: string): EstimatePricing | undefined {
  return isPreset(transport) ? JEV_PRESETS[transport].pricing : undefined;
}

function num(value: Unknowable, digits = 0): string {
  return value === 'unknown' ? 'unknown' : value.toFixed(digits);
}

function cost(value: CostEstimate): string {
  if (value === 'unknown') return 'unknown';
  return `$${value.usd.toFixed(6)} (as of ${value.asOf}; ${value.source})`;
}

function renderRun(est: RunEstimate): string[] {
  const hits = `${String(est.cacheHits)} cache hit${est.cacheHits === 1 ? '' : 's'}`;
  return [
    `calls: ${String(est.calls)} (${String(est.cases)} cases × ${String(est.criteria)} criteria in one call per case; ${hits})`,
    `input tokens: ~${String(est.inputTokens)}`,
    `cost: ${cost(est.cost)}`,
    `minutes: ${est.minutes.toFixed(1)} at ${String(est.callsPerMinute)} calls/min`,
  ];
}

function renderValidate(est: ValidateEstimate): string[] {
  const lines = renderRun(est.base).map((line) => `run ${line}`);
  for (const part of [...est.parts, { name: 'total', ...est.total }]) {
    lines.push(
      `${part.name}: calls ${num(part.calls)}, input tokens ${num(part.inputTokens)}, cost ${cost(part.cost)}, minutes ${num(part.minutes, 1)}`,
    );
  }
  return lines;
}

async function estimateCommand(options: EstimateOptions): Promise<void> {
  const log = getLogger();
  // No judge call is made, so the judge key may be unset: only its capabilities are read.
  const loaded = await loadVetConfig({
    cwd: process.cwd(),
    requireCredentials: false,
    ...(options.config === undefined ? {} : { configPath: options.config }),
  });
  for (const warning of loaded.warnings) log.warn(warning);
  const { config, rootDir, judge } = loaded;

  const criteriaPath = resolve(options.criteria ?? resolve(rootDir, 'evals/criteria.yaml'));
  const casesDir = resolve(options.cases ?? resolve(rootDir, 'evals/cases'));
  const criteria = await loadCriteria(criteriaPath);
  if (!criteria.ok) {
    const issue = criteria.issues[0];
    throw new VetError(
      issue?.code ?? CEV_ERROR_CODES.CRITERIA_INVALID,
      `cannot load ${criteriaPath}: ${issue?.message ?? 'invalid'}`,
    );
  }
  const cases = await loadCases(casesDir);
  if (!cases.ok) {
    const issue = cases.issues[0];
    throw new VetError(
      issue?.code ?? CEV_ERROR_CODES.CASE_INVALID,
      `cannot load ${casesDir}: ${issue?.message ?? 'invalid'}`,
    );
  }

  const pricing = pricingFor(judge.capabilities.transport);
  // `enabled: false` (vet criteria disable): never judged, so it never bills.
  const active = criteria.criteria.filter((c) => c.enabled !== false);
  const input = {
    criteria: active,
    cases: cases.cases,
    model: judge.capabilities.model,
    cacheDir: resolve(rootDir, config.cacheDir),
    ...(pricing === undefined ? {} : { pricing }),
  };
  const est = options.for === 'validate' ? await estimateValidate(input) : await estimateRun(input);
  for (const warning of est.warnings) log.warn(warning);
  emit(est, () => {
    if (cases.cases.length === 0) return 'nothing to estimate: no cases';
    return (est.for === 'validate' ? renderValidate(est) : renderRun(est)).join('\n');
  });
}

export function registerEstimate(program: Command): Command {
  return program
    .command('estimate')
    .description('estimate judge calls, tokens, cost and minutes, with no network call')
    .addOption(
      new Option('--for <command>', 'what to estimate').choices(['run', 'validate']).default('run'),
    )
    .option('--config <path>', 'config file (default: vetkit.config.* in the current directory)')
    .option('--criteria <file>', 'criteria file (default: evals/criteria.yaml next to the config)')
    .option('--cases <dir>', 'cases directory (default: evals/cases next to the config)')
    .action(async (_options: unknown, command: Command) => {
      await estimateCommand(command.optsWithGlobals<EstimateOptions>());
    });
}
