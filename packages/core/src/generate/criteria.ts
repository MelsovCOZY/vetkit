// Criteria proposal: one generator call turns failure modes into boolean Criterion
// candidates (one atomic yes/no per failure mode, with an escape option). Provenance ties
// each candidate to its failure mode's trace ids and to `<resolvedModelId>#<promptHash>`.
// A draft that breaks an error-severity lint rule (e.g. INVERTED_BOOLEAN) gets one re-draft
// in a single repair call; one that still fails is kept for the pipeline's lint to reject
// and report, never dropped silently here.
import { type Criterion, criterionSchema, type GeneratorV1, validateJson } from '@vetkit/spec';
import { computeWordingHash } from '../criteria/load.ts';
import { lintCriteria, type LintIssue } from '../criteria/lint.ts';
import type { Events } from '../events.ts';
import type { FailureMode } from './failure-modes.ts';
import {
  CRITERIA_PROMPT,
  CRITERIA_REPAIR_PROMPT,
  CRITERIA_SCHEMA,
  generateStructured,
  promptHash,
} from './prompts.ts';

export interface ProposeCriteriaInput {
  readonly generator: GeneratorV1;
  readonly failureModes: readonly FailureMode[];
  readonly signal?: AbortSignal;
  readonly events?: Events;
}

export interface ProposeCriteriaResult {
  readonly criteria: Criterion[];
  readonly promptHash: string;
  /** Ids whose rejected draft the repair re-draft fixed. */
  readonly repaired: string[];
  /** Ids whose draft still breaks an error-severity lint rule after the one re-draft. */
  readonly unrepaired: string[];
}

type Checkable = NonNullable<Criterion['checkable']>;

interface Draft {
  failureMode: string;
  instructions: string;
  escape: string;
  polarity: Criterion['polarity'];
  channel: Criterion['channel'];
  checkable: Checkable | 'none';
}

interface RawOutput {
  criteria: Draft[];
}

// Deterministic routing from the failure mode's own wording; the generator's tag is the
// fallback. Order matters: code and math before the broader factual pattern.
const CHECKABLE_PATTERNS: readonly (readonly [Checkable, RegExp])[] = [
  ['code', /\b(code|snippet|compile[sd]?|syntax|function|script|sql|regex)\b/i],
  ['math', /\b(arithmetic|math|calculat\w*|sum|total|numeric|number)\b/i],
  ['factual', /\b(fact\w*|incorrect information|hallucinat\w*|inaccura\w*|wrong information)\b/i],
];

function classify(mode: FailureMode): Checkable | undefined {
  const text = `${mode.name.replaceAll('-', ' ')} ${mode.description}`;
  return CHECKABLE_PATTERNS.find(([, re]) => re.test(text))?.[0];
}

function slug(name: string): string {
  const s = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-|-$/g, '');
  return s === '' ? 'criterion' : s;
}

function build(draft: Draft, mode: FailureMode, id: string, generator: string): Criterion {
  const checkable = classify(mode) ?? (draft.checkable === 'none' ? undefined : draft.checkable);
  return {
    id,
    type: 'boolean',
    instructions: draft.instructions,
    escape: draft.escape,
    polarity: draft.polarity,
    channel: draft.channel,
    provenance: { traceIds: [...mode.exampleTraceIds], generator },
    wordingHash: computeWordingHash({
      type: 'boolean',
      instructions: draft.instructions,
      escape: draft.escape,
    }),
    ...(checkable === undefined ? {} : { checkable }),
  };
}

function lintErrors(candidate: Criterion): LintIssue[] {
  return lintCriteria([candidate]).filter((i) => i.severity === 'error');
}

function valid(candidate: Criterion): boolean {
  return validateJson<Criterion>(candidate, criterionSchema).ok;
}

export async function proposeCriteria(input: ProposeCriteriaInput): Promise<ProposeCriteriaResult> {
  const { generator, failureModes, signal, events } = input;
  const hash = promptHash(CRITERIA_PROMPT);
  const opt = signal === undefined ? {} : { signal };
  const { value, resolvedModelId } = await generateStructured<RawOutput>(generator, {
    system: CRITERIA_PROMPT,
    prompt: failureModes
      .map((m) => `- ${m.name}: ${m.description.replaceAll('\n', ' ')}`)
      .join('\n'),
    name: 'criteria',
    schema: CRITERIA_SCHEMA,
    ...opt,
  });
  const provenanceGenerator = `${resolvedModelId ?? generator.id}#${hash}`;
  const byName = new Map(failureModes.map((m) => [m.name, m]));

  const criteria: Criterion[] = [];
  const ids = new Set<string>();
  const failing: { index: number; mode: FailureMode; issues: LintIssue[] }[] = [];
  let unknown = 0;
  let invalid = 0;
  for (const draft of value.criteria) {
    const mode = byName.get(draft.failureMode);
    if (mode === undefined) {
      unknown += 1;
      continue;
    }
    const base = slug(mode.name);
    let id = base;
    for (let n = 2; ids.has(id); n += 1) id = `${base}-${n}`;

    const candidate = build(draft, mode, id, provenanceGenerator);
    if (!valid(candidate)) {
      invalid += 1;
      continue;
    }
    ids.add(id);
    const issues = lintErrors(candidate);
    if (issues.length > 0) failing.push({ index: criteria.length, mode, issues });
    criteria.push(candidate);
  }

  const repaired: string[] = [];
  const unrepaired: string[] = [];
  if (failing.length > 0) {
    const { value: redrafts } = await generateStructured<RawOutput>(generator, {
      system: CRITERIA_REPAIR_PROMPT,
      prompt: failing
        .map(({ index, mode, issues }) =>
          [
            `- failureMode: ${mode.name}`,
            `  description: ${mode.description.replaceAll('\n', ' ')}`,
            `  rejected question: ${criteria[index]?.instructions ?? ''}`,
            `  broken rules: ${[...new Set(issues.map((i) => i.ruleId))].join(', ')}`,
          ].join('\n'),
        )
        .join('\n'),
      name: 'criteria_repair',
      schema: CRITERIA_SCHEMA,
      ...opt,
    });
    const pool = [...redrafts.criteria];
    for (const { index, mode } of failing) {
      const original = criteria[index];
      if (original === undefined) continue;
      const at = pool.findIndex((d) => d.failureMode === mode.name);
      const redraft = at === -1 ? undefined : pool.splice(at, 1)[0];
      const fixed =
        redraft === undefined ? undefined : build(redraft, mode, original.id, provenanceGenerator);
      if (fixed !== undefined && valid(fixed) && lintErrors(fixed).length === 0) {
        criteria[index] = fixed;
        repaired.push(original.id);
      } else {
        unrepaired.push(original.id);
      }
    }
    events?.diag('info', 'CRITERION_REPAIRED', 're-drafted criteria rejected by lint', {
      repaired: repaired.length,
    });
    if (unrepaired.length > 0) {
      events?.diag(
        'warn',
        'CRITERION_REPAIR_FAILED',
        'criteria still rejected by lint after repair',
        {
          unrepaired: unrepaired.length,
        },
      );
    }
  }

  if (unknown > 0) {
    events?.diag('info', 'UNKNOWN_FAILURE_MODE', 'dropped drafts naming no input failure mode', {
      dropped: unknown,
    });
  }
  if (invalid > 0) {
    events?.diag('warn', 'INVALID_CRITERION', 'dropped drafts failing the criterion schema', {
      dropped: invalid,
    });
  }
  return { criteria, promptHash: hash, repaired, unrepaired };
}
