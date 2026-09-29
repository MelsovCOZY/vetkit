// generateEvals: failure modes → criteria → Jev dedupe → lint → cases, then writes
// `<out>/criteria.yaml` and `<out>/cases/<batch>.jsonl` in the shapes loadCriteria and
// loadCases read. The generator is reached only through GeneratorV1 and Jev only through
// JudgeV1; refusals (unreadable source, existing outputs) are a report status, not a throw.
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stringify } from 'yaml';
import {
  CEV_ERROR_CODES,
  VetError,
  type Case,
  type CevErrorCode,
  type Criterion,
  type GeneratorV1,
  type JudgeV1,
  type NormalizedTrace,
  type SourceV1,
} from '@vetkit/spec';
import { lintCriteria, type LintIssue } from '../criteria/lint.ts';
import type { Events } from '../events.ts';
import { extractCases, type TraceStatus } from './cases.ts';
import { proposeCriteria } from './criteria.ts';
import { dedupeCriteria, type DuplicateRecord } from './dedupe.ts';
import { proposeFailureModes, type FailureMode } from './failure-modes.ts';

const CASES_BATCH_FILE = 'generated.jsonl';

export interface GenerateConfig {
  /** Keep at most this many criteria after lint. */
  readonly maxCriteria?: number;
}

export interface GenerateEvalsInput {
  readonly config?: GenerateConfig;
  readonly source: SourceV1;
  readonly generator: GeneratorV1;
  readonly judge: JudgeV1;
  /** Output directory, e.g. `evals`. */
  readonly out: string;
  /** Replace an existing criteria.yaml / cases/*.jsonl (the CLI's --force). */
  readonly overwrite: boolean;
  readonly signal?: AbortSignal;
  readonly events?: Events;
}

export interface GenerateIssue {
  readonly code: CevErrorCode;
  readonly message: string;
}

export interface GenerateReport {
  readonly status: 'ok' | 'refused';
  readonly issues: GenerateIssue[];
  readonly failureModes: FailureMode[];
  /** Error-severity lint issues; their criteria were dropped. */
  readonly rejected: LintIssue[];
  /** Ids of criteria whose lint-rejected draft one repair re-draft fixed. generateEvals always sets it. */
  readonly repaired?: string[];
  /** How many criteria lint dropped (after the repair re-draft). generateEvals always sets it. */
  readonly dropped?: number;
  /** Warn-severity lint issues on criteria that were kept. */
  readonly warnings: LintIssue[];
  readonly duplicates: DuplicateRecord[];
  readonly traces: TraceStatus[];
}

export interface GenerateEvalsResult {
  readonly criteria: Criterion[];
  readonly cases: Case[];
  readonly report: GenerateReport;
}

/** What generateEvals returns: every report field, including the repair counts, is set. */
type GeneratedEvals = GenerateEvalsResult & { readonly report: Required<GenerateReport> };

function refused(issue: GenerateIssue, traces: TraceStatus[] = []): GeneratedEvals {
  return {
    criteria: [],
    cases: [],
    report: {
      status: 'refused',
      issues: [issue],
      failureModes: [],
      rejected: [],
      repaired: [],
      dropped: 0,
      warnings: [],
      duplicates: [],
      traces,
    },
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function hasOutputs(out: string): Promise<boolean> {
  if (await exists(join(out, 'criteria.yaml'))) return true;
  try {
    return (await readdir(join(out, 'cases'))).some((name) => name.endsWith('.jsonl'));
  } catch {
    return false;
  }
}

async function readAll(source: SourceV1, signal?: AbortSignal): Promise<NormalizedTrace[]> {
  const traces: NormalizedTrace[] = [];
  for await (const trace of source.doRead(signal === undefined ? {} : { signal })) {
    traces.push(trace);
  }
  return traces;
}

export async function generateEvals(input: GenerateEvalsInput): Promise<GeneratedEvals> {
  const { source, generator, judge, out, signal, events } = input;

  if (!input.overwrite && (await hasOutputs(out))) {
    return refused({
      code: CEV_ERROR_CODES.E_IO,
      message: `${out} already holds criteria.yaml or cases/*.jsonl; pass overwrite to replace them`,
    });
  }
  if (source.capabilities.content === 'never') {
    return refused({
      code: CEV_ERROR_CODES.SOURCE_UNREADABLE,
      message: `source '${source.id}' captures no message content`,
    });
  }
  if (generator.capabilities.structured === 'json_object') {
    throw new VetError(
      CEV_ERROR_CODES.GENERATOR_CAPABILITY,
      `generator '${generator.id}' declares structured:'json_object', but generation needs a JSON Schema strategy (json_schema, tool or prompt)`,
    );
  }

  const traces = await readAll(source, signal);
  const usable = traces.filter((t) => t.completeness.contentCaptured);
  if (usable.length === 0) {
    return refused(
      { code: CEV_ERROR_CODES.SOURCE_UNREADABLE, message: 'no content captured in any trace' },
      extractCases({ traces, criteria: [] }).traces,
    );
  }

  const opt = {
    ...(signal === undefined ? {} : { signal }),
    ...(events === undefined ? {} : { events }),
  };
  const failureModes = await proposeFailureModes({ generator, traces: usable, ...opt });
  const { criteria: candidates, repaired } = await proposeCriteria({
    generator,
    failureModes,
    ...opt,
  });
  const { kept, duplicates } = await dedupeCriteria({ judge, candidates, ...opt });

  const issues = lintCriteria(kept);
  const rejected = issues.filter((i) => i.severity === 'error');
  const dropped = new Set(rejected.map((i) => i.criterionId));
  const surviving = kept.filter((c) => !dropped.has(c.id));
  const criteria = surviving.slice(0, input.config?.maxCriteria ?? surviving.length);
  const warnings = issues.filter(
    (i) => i.severity === 'warn' && criteria.some((c) => c.id === i.criterionId),
  );

  const extracted = extractCases({ traces, criteria });

  await mkdir(join(out, 'cases'), { recursive: true });
  await writeFile(join(out, 'criteria.yaml'), stringify({ criteria }), 'utf8');
  await writeFile(
    join(out, 'cases', CASES_BATCH_FILE),
    extracted.cases.map((c) => `${JSON.stringify(c)}\n`).join(''),
    'utf8',
  );

  return {
    criteria,
    cases: extracted.cases,
    report: {
      status: 'ok',
      issues: [],
      failureModes,
      rejected,
      repaired,
      dropped: dropped.size,
      warnings,
      duplicates,
      traces: extracted.traces,
    },
  };
}
