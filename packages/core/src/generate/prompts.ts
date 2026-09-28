// Generator prompts and output schemas for the proposal step (failure modes, then one
// yes/no criterion per failure mode). Templates are exported constants: promptHash() of a
// template is recorded in every candidate's provenance, so editing a template changes it.
// Output schemas are JSON Schema 2020-12 in strict-structured-output form (every property
// required, additionalProperties false) and are re-validated here with validateJson.
import { createHash } from 'node:crypto';
import { type GeneratorV1, type JsonSchema, safeParseJson, validateJson } from '@vetkit/spec';
import { LINT_RULES } from '../criteria/lint.ts';

export function promptHash(template: string): string {
  return createHash('sha256').update(template).digest('hex');
}

/** The failure-mode step asks for, and tops up towards, at least this many modes. */
export const MIN_FAILURE_MODES = 6;

export const FAILURE_MODES_PROMPT: string = `You are doing error analysis on traces from an LLM application.
You get a sample of traces. Each starts with "### trace <id>" and shows the end of the conversation.
The sample may start with a list of failure modes already found; do not repeat those.

Name the distinct ways the application fails in these traces.
Read every trace in turn. Aim for at least ${MIN_FAILURE_MODES} distinct failure modes: look at task outcome
(wrong, incomplete or unhelpful answers), safety (harm, policy, privacy) and quality (tone, format,
clarity, length), and include minor problems as well as severe ones.
Rules:
- One failure mode per distinct problem. Do not merge unrelated problems into one.
- A failure mode seen in only one trace still counts.
- name: short kebab-case, unique across your answer.
- description: one or two plain sentences saying what goes wrong, observable from the trace.
- exampleTraceIds: ids of traces in the sample that show this failure. Use only ids shown.
- Report only failures you can see in the sample. Do not invent failures.
- If you see no failures, return an empty list.`;

export const FAILURE_MODES_SCHEMA: JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    failureModes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1 },
          description: { type: 'string', minLength: 1 },
          exampleTraceIds: { type: 'array', items: { type: 'string' } },
        },
        required: ['name', 'description', 'exampleTraceIds'],
        additionalProperties: false,
      },
    },
  },
  required: ['failureModes'],
  additionalProperties: false,
};

const LINT_SUMMARY = LINT_RULES.map((rule) => `- ${rule.id}: ${rule.why}`).join('\n');

export const CRITERIA_PROMPT: string = `You write yes/no evaluation questions for a literal-minded judge model.
You get a list of failure modes. For each failure mode write one question that detects it.
Rules:
- failureMode: the exact name of the failure mode the question detects.
- instructions: one atomic, literal question about one observable claim. Never bundle two claims.
- escape: the escape option, a sentence the judge picks when the evidence is missing or the question does not apply.
- No counting, arithmetic, math, date comparison or colour codes. Those go to a code grader.
- No double negatives, and no negated wording where a plain positive question works.
- Ask whether something is present in the response, never whether it is missing, absent or lacking:
  write "Does the response cite the policy?", not "Is a citation missing from the response?".
- No vague words such as "good", "appropriate", "high quality" or "properly".
- polarity: "pass_when_false" when a yes means the failure happened, "pass_when_true" when a yes means the response is fine.
- channel: "outcome" (the task got done), "safety" (harm, policy, privacy) or "quality" (tone, style, clarity).
- checkable: "factual", "math" or "code" when the failure is about factual, arithmetic or code correctness, else "none".
A linter rejects questions that break these rules:
${LINT_SUMMARY}`;

export const CRITERIA_REPAIR_PROMPT: string = `You repair yes/no evaluation questions that a linter rejected.
You get a list of rejected questions. Each names its failure mode, the rejected question and the
lint rules it broke. For each one write one new question that detects the same failure mode and
breaks none of the rules below. Keep the escape option. Ask whether something is present, never
whether it is missing, absent or lacking; flip polarity when you flip the wording.
Rules for every field are the same as when the question was first written:
- failureMode: the exact failure-mode name given.
- instructions: one atomic, literal question about one observable claim.
- polarity: "pass_when_false" when a yes means the failure happened, "pass_when_true" when a yes means the response is fine.
- channel: "outcome", "safety" or "quality". checkable: "factual", "math", "code" or "none".
Lint rules:
${LINT_SUMMARY}`;

export const CRITERIA_SCHEMA: JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          failureMode: { type: 'string', minLength: 1 },
          instructions: { type: 'string', minLength: 1 },
          escape: { type: 'string', minLength: 1 },
          polarity: { enum: ['pass_when_true', 'pass_when_false'] },
          channel: { enum: ['outcome', 'safety', 'quality'] },
          checkable: { enum: ['none', 'factual', 'math', 'code'] },
        },
        required: ['failureMode', 'instructions', 'escape', 'polarity', 'channel', 'checkable'],
        additionalProperties: false,
      },
    },
  },
  required: ['criteria'],
  additionalProperties: false,
};

/**
 * One structured call; the value (or, for a prompt-mode generator, the text) is
 * re-validated against the schema. Throws the VetError from validation on mismatch.
 */
// T is the shape the caller's schema validates (same boundary assertion as validateJson<T>).
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters
export async function generateStructured<T>(
  generator: GeneratorV1,
  req: { system: string; prompt: string; name: string; schema: JsonSchema; signal?: AbortSignal },
): Promise<{ value: T; resolvedModelId?: string }> {
  const res = await generator.doGenerate({
    system: req.system,
    prompt: req.prompt,
    schema: { name: req.name, jsonSchema: req.schema },
    ...(req.signal === undefined ? {} : { signal: req.signal }),
  });
  const parsed =
    res.value === undefined && res.text !== undefined
      ? safeParseJson<T>(res.text, req.schema)
      : validateJson<T>(res.value, req.schema);
  if (!parsed.ok) throw parsed.error;
  return res.resolvedModelId === undefined
    ? { value: parsed.value }
    : { value: parsed.value, resolvedModelId: res.resolvedModelId };
}
