import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { z } from 'zod';
import { gatewayFetch, readJsonl } from './lib/index.ts';
import type { Trace } from './corpus.ts';

export type Criterion = {
  id: string;
  name: string;
  instructions: string;
  escape: string;
  /** traceIds this criterion was proposed from; null for the hand-written c1-c3. */
  provenance: string[] | null;
};

/**
 * c1-c3: hand-written, never produced by the generator. Ground truth for these three comes
 * from the corpus itself (golden reference answers, the unanswerable set and the Gemini
 * baseline judge), not from a generator call.
 */
export const FIXED_CRITERIA: readonly Criterion[] = [
  {
    id: 'c1',
    name: 'answer_correct',
    instructions:
      'The reference answer for this case is: {{reference}}. Does the answer state the same fact as the reference answer, even if worded differently?',
    escape: 'reference not comparable',
    provenance: null,
  },
  {
    id: 'c2',
    name: 'abstains_when_unanswerable',
    instructions:
      'Does the answer say that the provided documents contain no such information, rather than stating a fact?',
    escape: 'unclear',
    provenance: null,
  },
  {
    id: 'c3',
    name: 'faithful_to_context',
    instructions: 'Is every factual claim in the answer supported by the provided contexts?',
    escape: 'no factual claims',
    provenance: null,
  },
];

export type LintResult = { ok: true } | { ok: false; rule: string };

const LINT_RULES: {
  rule: string;
  fails: (c: { instructions: string; escape: string }) => boolean;
}[] = [
  { rule: 'missing escape option', fails: (c) => !c.escape || c.escape.trim().length === 0 },
  {
    rule: 'double negative',
    fails: (c) =>
      (
        c.instructions.match(
          /\b(not|never|none|neither|nor|isn't|doesn't|didn't|won't|cannot|can't)\b/gi,
        ) ?? []
      ).length >= 2,
  },
  {
    rule: 'asks Jev to count, compute or reason about dates',
    fails: (c) =>
      /\b(count|calculate|compute|how many|sum of|total number|date|day of the week)\b/i.test(
        c.instructions,
      ),
  },
  { rule: 'instructions over 200 characters', fails: (c) => c.instructions.length > 200 },
];

/** Pure lint over a criterion's prose; a table of rules so later work can cite which one fired. */
export function lintCriterion(criterion: { instructions: string; escape: string }): LintResult {
  for (const { rule, fails } of LINT_RULES) {
    if (fails(criterion)) return { ok: false, rule };
  }
  return { ok: true };
}

const SAMPLE_SIZE = 15;

/** Picks `n` traces evenly spread across the corpus, for a small, representative generator prompt. */
export function sampleTraces(traces: Trace[], n: number = SAMPLE_SIZE): Trace[] {
  if (traces.length <= n) return traces.slice();
  const step = traces.length / n;
  const picked: Trace[] = [];
  for (let i = 0; i < n; i++) {
    picked.push(traces[Math.floor(i * step)]);
  }
  return picked;
}

function summarizeTraceForPrompt(t: Trace): {
  traceId: string;
  lang: string;
  question: string;
  answer: string;
} {
  return { traceId: t.traceId, lang: t.lang, question: t.question, answer: t.answer };
}

type ChatMessage = { role: 'system' | 'user'; content: string };

export const FAILURE_MODES_SCHEMA = {
  name: 'failure_modes',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['failureModes'],
    properties: {
      failureModes: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'description', 'exampleTraceIds'],
          properties: {
            name: { type: 'string' },
            description: { type: 'string' },
            exampleTraceIds: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  },
} as const;

export const CRITERIA_SCHEMA = {
  name: 'criteria_from_failure_modes',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['criteria'],
    properties: {
      criteria: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'instructions', 'escape', 'provenanceTraceIds'],
          properties: {
            name: { type: 'string' },
            instructions: { type: 'string' },
            escape: { type: 'string' },
            provenanceTraceIds: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  },
} as const;

export const REGENERATE_CRITERION_SCHEMA = {
  name: 'regenerated_criterion',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['criterion'],
    properties: {
      criterion: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'instructions', 'escape', 'provenanceTraceIds'],
        properties: {
          name: { type: 'string' },
          instructions: { type: 'string' },
          escape: { type: 'string' },
          provenanceTraceIds: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
} as const;

const FailureModeZ = z.object({
  name: z.string(),
  description: z.string(),
  exampleTraceIds: z.array(z.string()),
});
const FailureModesReplyZ = z.object({ failureModes: z.array(FailureModeZ) });
type FailureMode = z.infer<typeof FailureModeZ>;

const CandidateCriterionZ = z.object({
  name: z.string(),
  instructions: z.string(),
  escape: z.string(),
  provenanceTraceIds: z.array(z.string()),
});
const CriteriaReplyZ = z.object({ criteria: z.array(CandidateCriterionZ) });
const RegeneratedReplyZ = z.object({ criterion: CandidateCriterionZ });
type CandidateCriterion = z.infer<typeof CandidateCriterionZ>;

/** A single structured-output generator call: sends the schema + messages, returns parsed JSON. */
export type GeneratorCall = (args: {
  schemaName: string;
  jsonSchema: object;
  messages: ChatMessage[];
}) => Promise<unknown>;

const DEFAULT_GENERATOR_MODEL = 'anthropic/claude-sonnet-5';

/** Wraps spike/lib's gatewayFetch as a GeneratorCall against the gateway's chat/completions dialect. */
export function makeGeneratorCall(model: string): GeneratorCall {
  return async ({ schemaName, jsonSchema, messages }) => {
    const response = await gatewayFetch<{
      model?: string;
      choices?: { message?: { content?: string } }[];
    }>(
      '/v1/chat/completions',
      {
        model,
        messages,
        response_format: {
          type: 'json_schema',
          json_schema: { name: schemaName, strict: true, schema: jsonSchema },
        },
      },
      { timeoutMs: 60_000 },
    );

    const content = response.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new Error(
        `propose.ts: generator response for ${schemaName} missing choices[0].message.content`,
      );
    }
    console.log(
      `propose.ts: generator call ${schemaName} served by model ${response.model ?? '(unknown)'}`,
    );
    return JSON.parse(content);
  };
}

function failureModePrompt(sample: Trace[], extra?: { existingNames: string[] }): ChatMessage[] {
  const traces = sample.map(summarizeTraceForPrompt);
  const base =
    'You are auditing a RAG system. Given these traces (question, answer, language), list distinct ' +
    'failure modes you observe or suspect (things a good answer should avoid or must do). For each, ' +
    'give a short name, a one-sentence description, and the traceIds of traces that show it.';
  const ask = extra
    ? `${base}\nYou already found: ${extra.existingNames.join(', ')}. List additional DISTINCT failure modes not already covered.`
    : base;
  return [
    { role: 'system', content: 'Respond only with JSON matching the given schema.' },
    { role: 'user', content: `${ask}\n\nTraces:\n${JSON.stringify(traces)}` },
  ];
}

function criteriaPrompt(failureModes: FailureMode[]): ChatMessage[] {
  return [
    { role: 'system', content: 'Respond only with JSON matching the given schema.' },
    {
      role: 'user',
      content:
        'For each failure mode below, write one atomic boolean criterion an evaluator could check against a ' +
        'single trace: a short name, one literal instructions sentence (no more than 200 characters, no double ' +
        'negatives, no counting/computing/dates), an escape label for when the criterion does not apply, and ' +
        'the provenanceTraceIds this criterion was derived from (reuse the exampleTraceIds given).\n\n' +
        `Failure modes:\n${JSON.stringify(failureModes)}`,
    },
  ];
}

function regeneratePrompt(candidate: CandidateCriterion, reason: string): ChatMessage[] {
  return [
    { role: 'system', content: 'Respond only with JSON matching the given schema.' },
    {
      role: 'user',
      content:
        `The following criterion failed review for: "${reason}". Rewrite it to fix that problem while keeping ` +
        `the same failure mode and provenanceTraceIds.\n\n${JSON.stringify(candidate)}`,
    },
  ];
}

export class ShortfallError extends Error {
  constructor(
    public readonly survivorCount: number,
    public readonly needed: number,
  ) {
    super(`propose.ts: only ${survivorCount} generated criteria survived lint, need ${needed}`);
    this.name = 'ShortfallError';
  }
}

const MIN_FAILURE_MODES = 10;
const NEEDED_GENERATED = 7;

/**
 * Two-model generation: asks the generator for failure modes over a sample of traces, then one
 * criterion per failure mode, lints each, regenerates a lint-failing one once, drops it if it
 * still fails (or its provenance doesn't resolve in the corpus), and returns the first 7
 * survivors as c4-c10.
 */
export async function proposeCriteria(traces: Trace[], call: GeneratorCall): Promise<Criterion[]> {
  const traceIdSet = new Set(traces.map((t) => t.traceId));
  const sample = sampleTraces(traces);

  let failureModesReply = FailureModesReplyZ.parse(
    await call({
      schemaName: FAILURE_MODES_SCHEMA.name,
      jsonSchema: FAILURE_MODES_SCHEMA.schema,
      messages: failureModePrompt(sample),
    }),
  );
  let failureModes = failureModesReply.failureModes;

  if (failureModes.length < MIN_FAILURE_MODES) {
    const more = FailureModesReplyZ.parse(
      await call({
        schemaName: FAILURE_MODES_SCHEMA.name,
        jsonSchema: FAILURE_MODES_SCHEMA.schema,
        messages: failureModePrompt(sample, { existingNames: failureModes.map((f) => f.name) }),
      }),
    );
    const seen = new Set(failureModes.map((f) => f.name));
    failureModes = [...failureModes, ...more.failureModes.filter((f) => !seen.has(f.name))];
  }

  const criteriaReply = CriteriaReplyZ.parse(
    await call({
      schemaName: CRITERIA_SCHEMA.name,
      jsonSchema: CRITERIA_SCHEMA.schema,
      messages: criteriaPrompt(failureModes),
    }),
  );

  const survivors: Criterion[] = [];
  for (const candidate of criteriaReply.criteria) {
    const hasBadProvenance = candidate.provenanceTraceIds.some((id) => !traceIdSet.has(id));
    if (hasBadProvenance) continue;

    let current = candidate;
    let lint = lintCriterion(current);
    if (!lint.ok) {
      const regenerated = RegeneratedReplyZ.parse(
        await call({
          schemaName: REGENERATE_CRITERION_SCHEMA.name,
          jsonSchema: REGENERATE_CRITERION_SCHEMA.schema,
          messages: regeneratePrompt(current, lint.rule),
        }),
      ).criterion;

      if (regenerated.provenanceTraceIds.some((id) => !traceIdSet.has(id))) continue;
      current = regenerated;
      lint = lintCriterion(current);
      if (!lint.ok) continue;
    }

    survivors.push({
      id: '',
      name: current.name,
      instructions: current.instructions,
      escape: current.escape,
      provenance: current.provenanceTraceIds,
    });
  }

  if (survivors.length < NEEDED_GENERATED) {
    throw new ShortfallError(survivors.length, NEEDED_GENERATED);
  }

  return survivors.slice(0, NEEDED_GENERATED).map((c, i) => ({ ...c, id: `c${i + 4}` }));
}

export function handleShortfall(
  err: ShortfallError,
  log: (msg: string) => void,
  exit: (code: number) => void,
): void {
  log(err.message);
  exit(1);
}

async function main(): Promise<void> {
  const spikeDataDir = fileURLToPath(new URL('./data/', import.meta.url));
  const traces = await readJsonl<Trace>(join(spikeDataDir, 'traces.jsonl'));
  const model = process.env.SPIKE_GENERATOR_MODEL ?? DEFAULT_GENERATOR_MODEL;
  const call = makeGeneratorCall(model);

  let generated: Criterion[];
  try {
    generated = await proposeCriteria(traces, call);
  } catch (err) {
    if (err instanceof ShortfallError) {
      handleShortfall(
        err,
        (msg) => console.error(msg),
        (code) => process.exit(code),
      );
      return;
    }
    throw err;
  }

  const criteria = [...FIXED_CRITERIA, ...generated];
  await writeFile(
    join(spikeDataDir, 'criteria.json'),
    `${JSON.stringify(criteria, null, 2)}\n`,
    'utf8',
  );
  console.log(`propose.ts: wrote ${criteria.length} criteria to spike/data/criteria.json`);
}

if (import.meta.main) {
  await main();
}
