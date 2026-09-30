// The published `--json` document of every `vet` command, as JSON Schemas (draft 2020-12). The
// CLI test validates each command's real stdout against these objects, and
// renderJsonShapesMarkdown() renders the docs page from the same objects, so the docs cannot drift.
// Schemas list every currently emitted top-level field as `required`; `additionalProperties: true`
// keeps additive evolution non-breaking. Error documents are handleError's (errors.ts), not here.
import type { JsonSchema } from '@vetkit/spec';

export type JsonShapeKey =
  | '--version'
  | 'doctor'
  | 'init'
  | 'init --source'
  | 'init --source otlp'
  | 'label'
  | 'run'
  | 'rerun'
  | 'validate'
  | 'estimate'
  | 'check'
  | 'lock refresh'
  | 'criteria disable'
  | 'criteria enable'
  | 'criteria delete'
  | 'criteria revalidate'
  | 'cases dedupe'
  | 'cases quarantine'
  | 'cases promote'
  | 'cases review'
  | 'lint'
  | 'export'
  | 'watch'
  | 'migrate';

const DIALECT = 'https://json-schema.org/draft/2020-12/schema';

const str: JsonSchema = { type: 'string' };
const int: JsonSchema = { type: 'integer' };
const bool: JsonSchema = { type: 'boolean' };
const obj: JsonSchema = { type: 'object' };
const strings: JsonSchema = { type: 'array', items: str };
const list: JsonSchema = { type: 'array' };

// An object schema whose `required` is every property except the named optional ones.
function object(
  properties: Record<string, JsonSchema>,
  optional: readonly string[] = [],
  title?: string,
): JsonSchema {
  return {
    ...(title === undefined ? {} : { title }),
    type: 'object',
    additionalProperties: true,
    properties,
    required: Object.keys(properties).filter((k) => !optional.includes(k)),
  };
}

function shape(schema: JsonSchema, example: unknown): JsonSchema {
  return { $schema: DIALECT, additionalProperties: true, ...schema, examples: [example] };
}

// A document that is one of several object variants (the command picks by flags or branch).
function variants(...branches: JsonSchema[]): JsonSchema {
  return { type: 'object', oneOf: branches };
}

const model = { requested: 'jev', resolved: 'jev-2026', transport: 'gateway', pinned: false };
const summary = {
  total: 1,
  passed: 1,
  failed: 0,
  unscored: 0,
  aborted: false,
  byCriterion: {},
};
const verdict = {
  caseId: 'case-1',
  criterionId: 'tone',
  status: 'ok',
  pass: true,
  borderline: false,
};
const runRecord = {
  results: [verdict],
  summary,
  model,
  exitCode: 0,
  gateReasons: [],
};
const lockReport = {
  stale: false,
  reasons: [],
  criteria: [],
  releaseDate: 'unknown',
  staleCriteria: [],
  lockPath: 'criteria.lock.json',
};
const runEstimate = {
  for: 'run',
  cases: 1,
  criteria: 1,
  cacheHits: 0,
  calls: 1,
  inputTokens: 131,
  cost: 'unknown',
  minutes: 0.04,
  callsPerMinute: 25,
  warnings: [],
};
const generated = {
  criteria: [],
  cases: [],
  report: { status: 'ok', issues: [] },
  generator: { calls: 2, inputTokens: null, outputTokens: null, estimatedUsd: null },
};
const generatedProps = { criteria: list, cases: list, report: obj, generator: obj };

const runProps = { results: list, summary: obj, model: obj, exitCode: int, gateReasons: strings };
const runEstimateProps = {
  for: { const: 'run' },
  cases: int,
  criteria: int,
  cacheHits: int,
  calls: int,
  inputTokens: int,
  cost: {},
  minutes: { type: 'number' },
  callsPerMinute: { type: 'number' },
  warnings: strings,
};
const lockReportProps = {
  stale: bool,
  reasons: strings,
  criteria: list,
  releaseDate: str,
  staleCriteria: list,
  lockPath: str,
};
const outboxProps = { produced: int, acknowledged: int, skipped: int, dead: int };

export const JSON_SHAPES: Readonly<Record<JsonShapeKey, JsonSchema>> = {
  '--version': shape(object({ version: str }), { version: '0.1.0' }),
  doctor: shape(object({ checks: list, exitCode: { enum: [0, 1] }, config: obj }, ['config']), {
    checks: [{ name: 'node', status: 'pass', detail: 'v22.12.0 >= 22.12' }],
    exitCode: 0,
  }),
  init: shape(object({ files: strings }), { files: ['vetkit.config.ts', 'evals/criteria.yaml'] }),
  'init --source': shape(
    object({ ...generatedProps, summary: obj, reason: str }, ['summary', 'reason']),
    generated,
  ),
  'init --source otlp': shape(
    object({ ...generatedProps, summary: obj, reason: str }, ['reason']),
    { ...generated, summary: { cases: 1, excluded: {}, dialects: { gen_ai: 1 }, tokens: 165 } },
  ),
  label: shape(object({ imported: int, files: strings }), {
    imported: 120,
    files: ['evals/labels/tone.csv'],
  }),
  run: shape(object(runProps), runRecord),
  rerun: shape(
    object({
      ...runProps,
      criteriaPath: str,
      casesPath: str,
      startedAt: str,
      comparison: obj,
    }),
    {
      ...runRecord,
      criteriaPath: 'evals/criteria.yaml',
      casesPath: 'evals/cases',
      startedAt: '2026-09-30T08:00:00.000Z',
      comparison: { tone: { meanDiff: 0, se: 0, ci95: [0, 0], nPairs: 1, nClusters: 1 } },
    },
  ),
  validate: shape(object({ criteria: list, model: obj, datasetHash: str, lockPath: str }), {
    criteria: [{ id: 'tone', status: 'calibrated' }],
    model,
    datasetHash: 'abc123',
    lockPath: 'criteria.lock.json',
  }),
  estimate: shape(
    variants(
      object(runEstimateProps, [], 'estimate for run'),
      object(
        {
          for: { const: 'validate' },
          base: obj,
          parts: list,
          total: obj,
          warnings: strings,
        },
        [],
        'estimate --for validate',
      ),
    ),
    runEstimate,
  ),
  check: shape(
    variants(
      object(lockReportProps, [], 'lock check (default)'),
      object(outboxProps, [], 'outbox reconcile (--outbox alone)'),
      object({ lock: obj, outbox: obj }, [], 'both (--lock and --outbox)'),
    ),
    lockReport,
  ),
  'lock refresh': shape(
    object({ refreshed: strings, refreshedWhitespace: strings, stale: list, lockPath: str }),
    { refreshed: ['tone'], refreshedWhitespace: [], stale: [], lockPath: 'criteria.lock.json' },
  ),
  'criteria disable': shape(object({ disabled: str, files: strings }), {
    disabled: 'tone',
    files: ['evals/criteria.yaml'],
  }),
  'criteria enable': shape(object({ enabled: str, files: strings }), {
    enabled: 'tone',
    files: ['evals/criteria.yaml'],
  }),
  'criteria delete': shape(object({ removed: str, files: strings }), {
    removed: 'tone',
    files: ['evals/criteria.yaml'],
  }),
  'criteria revalidate': shape(object({ revalidate: str, files: strings }), {
    revalidate: 'tone',
    files: ['criteria.lock.json'],
  }),
  'cases dedupe': shape(object({ duplicates: list, nearDuplicates: list, written: bool }), {
    duplicates: [],
    nearDuplicates: [],
    written: false,
  }),
  'cases quarantine': shape(object({ id: str, status: str }), {
    id: 'case-2',
    status: 'quarantined',
  }),
  'cases promote': shape(object({ promoted: obj }), {
    promoted: { id: 'promoted-t1-tone', input: { state: 'User: hi' }, tags: [] },
  }),
  'cases review': shape(object({ remaining: int }), { remaining: 0 }),
  lint: shape(object({ issues: list }), { issues: [] }),
  migrate: shape(object({ files: list, migrated: int }), {
    files: [
      { path: 'evals/criteria.yaml', format: 'criteria', from: null, to: 1, action: 'stamped' },
    ],
    migrated: 1,
  }),
  export: shape(object({ files: strings, include: str }), {
    files: ['evals/vitest/criteria.yaml.evals.test.ts'],
    include: 'evals/vitest/**/*.evals.test.ts',
  }),
  watch: shape(
    object({
      seen: int,
      sampled: int,
      judged: int,
      unscored: int,
      unscoredCauses: strings,
      promoted: int,
      produced: int,
      acknowledged: int,
      excluded: obj,
      promotedSkipped: int,
    }),
    {
      seen: 0,
      sampled: 0,
      judged: 0,
      unscored: 0,
      unscoredCauses: [],
      promoted: 0,
      produced: 0,
      acknowledged: 0,
      excluded: { content_not_captured: 0, truncated: 0, incomplete_trace: 0 },
      promotedSkipped: 0,
    },
  ),
};

function fieldTable(schema: JsonSchema): string[] {
  const properties: Record<string, JsonSchema> = schema['properties'] ?? {};
  const required: readonly string[] = schema['required'] ?? [];
  const rows = Object.entries(properties).map(([name, prop]) => {
    const type = 'const' in prop ? JSON.stringify(prop['const']) : (prop['type'] ?? 'any');
    return `| \`${name}\` | ${String(type)} | ${required.includes(name) ? 'yes' : 'no'} |`;
  });
  return ['| field | type | required |', '| --- | --- | --- |', ...rows];
}

/** One H2 section per JSON_SHAPES key: a fenced json example and the field table. */
export function renderJsonShapesMarkdown(): string {
  const sections = Object.entries(JSON_SHAPES).map(([key, schema]) => {
    const branches: JsonSchema[] = schema['oneOf'] ?? [schema];
    const tables = branches.flatMap((branch) => [
      ...(typeof branch['title'] === 'string' ? [`**${branch['title']}**`, ''] : []),
      ...fieldTable(branch),
      '',
    ]);
    const example: unknown = schema['examples']?.[0];
    return [`## ${key}`, '', '```json', JSON.stringify(example, null, 2), '```', '', ...tables]
      .join('\n')
      .trimEnd();
  });
  return `${sections.join('\n\n')}\n`;
}
