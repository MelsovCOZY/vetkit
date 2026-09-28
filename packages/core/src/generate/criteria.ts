// Criteria proposal: one generator call turns failure modes into boolean Criterion
// candidates (one atomic yes/no per failure mode, with an escape option). Provenance ties
// each candidate to its failure mode's trace ids and to `<resolvedModelId>#<promptHash>`.
import { type Criterion, criterionSchema, type GeneratorV1, validateJson } from '@vetkit/spec';
import { computeWordingHash } from '../criteria/load.ts';
import type { Events } from '../events.ts';
import type { FailureMode } from './failure-modes.ts';
import { CRITERIA_PROMPT, CRITERIA_SCHEMA, generateStructured, promptHash } from './prompts.ts';

export interface ProposeCriteriaInput {
  readonly generator: GeneratorV1;
  readonly failureModes: readonly FailureMode[];
  readonly signal?: AbortSignal;
  readonly events?: Events;
}

export interface ProposeCriteriaResult {
  readonly criteria: Criterion[];
  readonly promptHash: string;
}

type Checkable = NonNullable<Criterion['checkable']>;

interface RawOutput {
  criteria: {
    failureMode: string;
    instructions: string;
    escape: string;
    polarity: Criterion['polarity'];
    channel: Criterion['channel'];
    checkable: Checkable | 'none';
  }[];
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

export async function proposeCriteria(input: ProposeCriteriaInput): Promise<ProposeCriteriaResult> {
  const { generator, failureModes, signal, events } = input;
  const hash = promptHash(CRITERIA_PROMPT);
  const { value, resolvedModelId } = await generateStructured<RawOutput>(generator, {
    system: CRITERIA_PROMPT,
    prompt: failureModes
      .map((m) => `- ${m.name}: ${m.description.replaceAll('\n', ' ')}`)
      .join('\n'),
    name: 'criteria',
    schema: CRITERIA_SCHEMA,
    ...(signal === undefined ? {} : { signal }),
  });
  const provenanceGenerator = `${resolvedModelId ?? generator.id}#${hash}`;
  const byName = new Map(failureModes.map((m) => [m.name, m]));

  const criteria: Criterion[] = [];
  const ids = new Set<string>();
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

    const checkable = classify(mode) ?? (draft.checkable === 'none' ? undefined : draft.checkable);
    const candidate: Criterion = {
      id,
      type: 'boolean',
      instructions: draft.instructions,
      escape: draft.escape,
      polarity: draft.polarity,
      channel: draft.channel,
      provenance: { traceIds: [...mode.exampleTraceIds], generator: provenanceGenerator },
      wordingHash: computeWordingHash({
        type: 'boolean',
        instructions: draft.instructions,
        escape: draft.escape,
      }),
      ...(checkable === undefined ? {} : { checkable }),
    };
    if (!validateJson<Criterion>(candidate, criterionSchema).ok) {
      invalid += 1;
      continue;
    }
    ids.add(id);
    criteria.push(candidate);
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
  return { criteria, promptHash: hash };
}
