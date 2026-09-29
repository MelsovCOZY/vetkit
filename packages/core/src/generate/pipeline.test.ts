// Tests for generateEvals (the J2 pipeline: failure modes → criteria → Jev dedupe → lint →
// cases). extractCases and dedupeCriteria have their own test files (cases.test.ts,
// dedupe.test.ts).
import { mkdtemp, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  VetError,
  type Answer,
  type Criterion,
  type GeneratorV1,
  type JudgeV1,
  type NormalizedTrace,
  type SourceV1,
} from '@vetkit/spec';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { loadCases } from '../cases/load.ts';
import { loadCriteria } from '../criteria/load.ts';
import { generateEvals } from './pipeline.ts';
import { CRITERIA_PROMPT } from './prompts.ts';

type DoGenerate = GeneratorV1['doGenerate'];
type DoJudge = JudgeV1['doJudge'];
type JudgeRequest = Parameters<DoJudge>[0];

// ---------------------------------------------------------------- fixtures

function trace(traceId: string, extra: Partial<NormalizedTrace> = {}): NormalizedTrace {
  return {
    traceId,
    spans: [],
    messages: [
      { role: 'system', parts: [{ type: 'text', content: 'You are a support agent.' }] },
      { role: 'user', parts: [{ type: 'text', content: `Where is order ${traceId}?` }] },
      { role: 'assistant', parts: [{ type: 'text', content: `Order ${traceId} ships today.` }] },
    ],
    dialect: 'test',
    completeness: { contentCaptured: true, truncated: false, missingParents: false },
    ...extra,
  };
}

const uncaptured = (id: string): NormalizedTrace =>
  trace(id, {
    messages: [],
    completeness: { contentCaptured: false, truncated: false, missingParents: false },
  });

const DISSIMILAR = [
  'Does the response use sarcasm toward the user?',
  "Does the response reveal another customer's email address?",
  'Does the response describe a product feature absent from the catalogue?',
  "Does the response change the subject away from the user's question?",
  "Does the response use a language other than the language of the user's message?",
];

const REFUND = 'Does the response state a refund amount that differs from the order total?';
const REFUND_DUP =
  'Does the response state a refund amount that differs from the order total shown?';

interface FakeJudge {
  readonly judge: JudgeV1;
  readonly doJudge: ReturnType<typeof vi.fn<DoJudge>>;
}

/** Answers every choice question with its first non-'none' option at `probability`. */
function fakeJudge(probability = 0.9, pick: 'first' | 'none' = 'first'): FakeJudge {
  const doJudge = vi.fn<DoJudge>((req: JudgeRequest) => {
    const answers: Record<string, Answer> = {};
    for (const [key, q] of Object.entries(req.questions)) {
      if (q.type !== 'choice') continue;
      const keys = Object.keys(q.criteria);
      const choice = pick === 'none' ? 'none' : (keys.find((k) => k !== 'none') ?? 'none');
      const probabilities = Object.fromEntries(
        keys.map((k) => [k, k === choice ? probability : (1 - probability) / (keys.length - 1)]),
      );
      answers[key] = { type: 'choice', choice, confidence: probability, probabilities };
    }
    return Promise.resolve({
      answers,
      usage: { inputTokens: 1, outputTokens: 1 },
      model: { requested: 'jev', resolved: 'jev-1.13', transport: 'fake', pinned: false },
    });
  });
  const judge: JudgeV1 = {
    specVersion: 'v1',
    id: 'fake-jev',
    capabilities: {
      questionTypes: ['boolean', 'choice', 'score'],
      maxStateTokens: 32_000,
      pinned: false,
      transport: 'fake',
      model: 'jev',
    },
    doJudge,
  };
  return { judge, doJudge };
}

// ---------------------------------------------------------------- generateEvals

const MODES = [
  ['wrong-refund', 'The assistant quotes a refund figure that differs from the order.'],
  ['rude-tone', 'The assistant is sarcastic toward the user.'],
  ['leaks-pii', 'The assistant reveals personal data of other customers.'],
  ['wrong-facts', 'The assistant states factually incorrect information about the product.'],
  ['off-topic', 'The assistant changes the subject.'],
  ['wrong-language', 'The assistant answers in a different language from the user.'],
  ['too-long', 'The assistant writes far more sentences than needed.'],
] as const;

function draft(failureMode: string, instructions: string, channel: Criterion['channel']): unknown {
  return {
    failureMode,
    instructions,
    escape: 'The response is missing or empty.',
    polarity: 'pass_when_false',
    channel,
    checkable: 'none',
  };
}

function drafts(): unknown[] {
  return [
    draft('wrong-refund', REFUND, 'outcome'),
    draft('rude-tone', DISSIMILAR[0] ?? '', 'quality'),
    draft('leaks-pii', DISSIMILAR[1] ?? '', 'safety'),
    draft('wrong-facts', DISSIMILAR[2] ?? '', 'outcome'),
    draft('off-topic', DISSIMILAR[3] ?? '', 'outcome'),
    draft('wrong-language', DISSIMILAR[4] ?? '', 'quality'),
    draft('wrong-refund', REFUND_DUP, 'outcome'),
    draft('too-long', 'How many sentences does the response contain?', 'quality'),
  ];
}

interface FakeGenerator {
  readonly generator: GeneratorV1;
  readonly doGenerate: ReturnType<typeof vi.fn<DoGenerate>>;
}

function fakeGenerator(
  structured: GeneratorV1['capabilities']['structured'] = 'json_schema',
  criteria: unknown = { criteria: drafts() },
): FakeGenerator {
  const doGenerate = vi.fn<DoGenerate>((req) => {
    if (req.schema?.name === 'failure_modes') {
      return Promise.resolve({
        value: {
          failureModes: MODES.map(([name, description], i) => ({
            name,
            description,
            exampleTraceIds: [`t${String(i).padStart(2, '0')}`],
          })),
        },
        resolvedModelId: 'acme/model-1',
      });
    }
    return Promise.resolve({ value: criteria, resolvedModelId: 'acme/model-1' });
  });
  const generator: GeneratorV1 = {
    specVersion: 'v1',
    id: 'fake-gen',
    capabilities: { structured, streaming: false },
    doGenerate,
  };
  return { generator, doGenerate };
}

function fakeSource(
  traces: readonly NormalizedTrace[],
  content: SourceV1['capabilities']['content'] = 'captured',
): SourceV1 {
  return {
    specVersion: 'v1',
    id: 'fake-source',
    capabilities: { streaming: false, content },
    async *doRead() {
      await Promise.resolve();
      yield* traces;
    },
  };
}

const TRACES: NormalizedTrace[] = [
  ...Array.from({ length: 24 }, (_, i) => trace(`t${String(i).padStart(2, '0')}`)),
  uncaptured('t-uncaptured'),
];

describe('generateEvals', () => {
  let out: string;
  const fetchSpy = vi.fn(() => Promise.reject(new Error('no network in generateEvals')));

  beforeEach(async () => {
    out = join(await mkdtemp(join(tmpdir(), 'vetkit-gen-')), 'evals');
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    fetchSpy.mockClear();
    await rm(join(out, '..'), { recursive: true, force: true });
  });

  test('writes criteria.yaml and cases/*.jsonl that round-trip through the loaders', async () => {
    const { generator, doGenerate } = fakeGenerator();
    const { judge, doJudge } = fakeJudge(0.9);

    const result = await generateEvals({
      source: fakeSource(TRACES),
      generator,
      judge,
      out,
      overwrite: false,
    });

    expect(result.report.status).toBe('ok');
    const loaded = await loadCriteria(join(out, 'criteria.yaml'));
    expect(loaded).toEqual({ ok: true, criteria: expect.any(Array) });
    if (!loaded.ok) return;
    expect(loaded.criteria.length).toBeGreaterThanOrEqual(5);
    expect(loaded.criteria.map((c) => c.id)).toEqual(result.criteria.map((c) => c.id));
    for (const c of loaded.criteria) {
      expect(['boolean', 'choice', 'score']).toContain(c.type);
      expect((c.escape ?? '').trim()).not.toBe('');
      expect(c.provenance.traceIds.length).toBeGreaterThan(0);
    }

    const files = await readdir(join(out, 'cases'));
    expect(files.some((f) => f.endsWith('.jsonl'))).toBe(true);
    const cases = await loadCases(join(out, 'cases'));
    expect(cases).toEqual({ ok: true, cases: expect.any(Array) });
    if (!cases.ok) return;
    expect(cases.cases.length).toBeGreaterThanOrEqual(20);
    expect(cases.cases).toEqual(result.cases);
    for (const c of cases.cases) {
      // Partial match (bug classified-evals-mol-dh8.6): extractCases also sets
      // provenance.traceId (and, when a span covers the final answer, spanId) — this test
      // only cares that traceIds survives and traceId is a string, not the full shape.
      expect(c.provenance).toEqual(
        expect.objectContaining({ traceIds: [expect.any(String)], traceId: expect.any(String) }),
      );
      expect(c).not.toHaveProperty('expected');
    }

    // Call budget: generator ≤ 3 + ceil(traces/20); Jev ≤ 1 per 50 candidates. No other client.
    expect(doGenerate.mock.calls.length).toBeLessThanOrEqual(3 + Math.ceil(TRACES.length / 20));
    expect(doJudge.mock.calls.length).toBeLessThanOrEqual(Math.ceil(drafts().length / 50));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('reports failure modes, dedupe merges, lint rejections and not_applicable traces', async () => {
    const { generator } = fakeGenerator();
    const { judge, doJudge } = fakeJudge(0.9);

    const { criteria, report } = await generateEvals({
      source: fakeSource(TRACES),
      generator,
      judge,
      out,
      overwrite: false,
    });

    expect(report.failureModes.map((m) => m.name)).toEqual(MODES.map(([name]) => name));
    expect(doJudge).toHaveBeenCalledTimes(1);
    expect(report.duplicates).toEqual([
      expect.objectContaining({ id: 'wrong-refund-2', duplicateOf: 'wrong-refund' }),
    ]);
    expect(report.rejected).toContainEqual(
      expect.objectContaining({ criterionId: 'too-long', ruleId: 'COMPUTATION' }),
    );
    const ids = criteria.map((c) => c.id);
    expect(ids).not.toContain('wrong-refund-2');
    expect(ids).not.toContain('too-long');
    expect(criteria.find((c) => c.id === 'wrong-facts')?.checkable).toBe('factual');
    expect(report.traces).toContainEqual(
      expect.objectContaining({ traceId: 't-uncaptured', status: 'not_applicable' }),
    );
  });

  test('maxCriteria caps the criteria written', async () => {
    const { generator } = fakeGenerator();
    const { judge } = fakeJudge(0.9);

    const { criteria } = await generateEvals({
      config: { maxCriteria: 3 },
      source: fakeSource(TRACES),
      generator,
      judge,
      out,
      overwrite: false,
    });

    expect(criteria).toHaveLength(3);
    const loaded = await loadCriteria(join(out, 'criteria.yaml'));
    expect(loaded.ok && loaded.criteria.length).toBe(3);
  });

  test('a json_object generator is GENERATOR_CAPABILITY before any call, never a downgrade', async () => {
    const { generator, doGenerate } = fakeGenerator('json_object');
    const { judge } = fakeJudge();

    const run = generateEvals({
      source: fakeSource(TRACES),
      generator,
      judge,
      out,
      overwrite: false,
    });

    await expect(run).rejects.toSatisfy(
      (e: unknown) => VetError.isInstance(e) && e.code === 'GENERATOR_CAPABILITY',
    );
    expect(doGenerate).not.toHaveBeenCalled();
  });

  test('generator output failing the requested schema is rejected and nothing is written', async () => {
    const { generator } = fakeGenerator('json_schema', { criteria: [{ instructions: 42 }] });
    const { judge } = fakeJudge();

    const run = generateEvals({
      source: fakeSource(TRACES),
      generator,
      judge,
      out,
      overwrite: false,
    });

    await expect(run).rejects.toSatisfy((e: unknown) => VetError.isInstance(e));
    await expect(readdir(out)).rejects.toThrow();
  });

  test('a source that never captures content is refused with SOURCE_UNREADABLE and no calls', async () => {
    const { generator, doGenerate } = fakeGenerator();
    const { judge, doJudge } = fakeJudge();

    const { report, criteria, cases } = await generateEvals({
      source: fakeSource(TRACES, 'never'),
      generator,
      judge,
      out,
      overwrite: false,
    });

    expect(report.status).toBe('refused');
    expect(report.issues).toContainEqual(expect.objectContaining({ code: 'SOURCE_UNREADABLE' }));
    expect(criteria).toEqual([]);
    expect(cases).toEqual([]);
    expect(doGenerate).not.toHaveBeenCalled();
    expect(doJudge).not.toHaveBeenCalled();
  });

  test('traces with no captured content at all are refused with SOURCE_UNREADABLE', async () => {
    const { generator, doGenerate } = fakeGenerator();
    const { judge } = fakeJudge();

    const { report } = await generateEvals({
      source: fakeSource([uncaptured('a'), uncaptured('b')], 'maybe'),
      generator,
      judge,
      out,
      overwrite: false,
    });

    expect(report.status).toBe('refused');
    expect(report.issues).toContainEqual(expect.objectContaining({ code: 'SOURCE_UNREADABLE' }));
    expect(doGenerate).not.toHaveBeenCalled();
  });

  test('existing outputs are kept unless overwrite is true', async () => {
    await mkdir(out, { recursive: true });
    await writeFile(join(out, 'criteria.yaml'), 'criteria: []\n');
    const first = fakeGenerator();
    const { judge } = fakeJudge(0.9);

    const refused = await generateEvals({
      source: fakeSource(TRACES),
      generator: first.generator,
      judge,
      out,
      overwrite: false,
    });

    expect(refused.report.status).toBe('refused');
    expect(first.doGenerate).not.toHaveBeenCalled();
    const kept = await loadCriteria(join(out, 'criteria.yaml'));
    expect(kept.ok && kept.criteria).toEqual([]);

    const forced = await generateEvals({
      source: fakeSource(TRACES),
      generator: fakeGenerator().generator,
      judge,
      out,
      overwrite: true,
    });

    expect(forced.report.status).toBe('ok');
    const written = await loadCriteria(join(out, 'criteria.yaml'));
    expect(written.ok && written.criteria.length).toBeGreaterThanOrEqual(5);
  });

  describe('with a fake generator that behaves like the observed model', () => {
    // Observed (final cold gate, F-J2): the first failure-mode call names one mode, and the
    // criteria call words its question as an absence ("Is ... missing ...?"), which
    // INVERTED_BOOLEAN rejects. Only a top-up call and a repair re-draft recover.
    const OBSERVED_MODES = [
      ['missing-citation', 'The assistant answers a policy question without citing the policy.'],
      ['rude-tone', 'The assistant is sarcastic toward the user.'],
      ['leaks-pii', 'The assistant reveals personal data of other customers.'],
      ['off-topic', 'The assistant changes the subject.'],
      ['wrong-language', 'The assistant answers in a different language from the user.'],
      ['no-order-status', 'The assistant never tells the user where the order is.'],
    ] as const;
    const INVERTED: Record<string, string> = {
      'missing-citation': 'Is a citation of the refund policy missing from the response?',
      'rude-tone': 'Is a courteous register absent from the reply to the customer?',
      'leaks-pii': 'Is redaction of third-party email addresses lacking in the answer?',
      'off-topic': 'Does the reply omit any answer to the question the user asked?',
      'wrong-language': "Is the language of the user's message missing from the response?",
      'no-order-status': 'Does the message lack a shipping status for the order?',
    };
    const POSITIVE: Record<string, string> = {
      'missing-citation': 'Does the response cite the refund policy document?',
      'rude-tone': 'Does the reply use sarcasm toward the customer?',
      'leaks-pii': "Does the answer reveal another customer's email address?",
      'off-topic': "Does the reply change the subject away from the user's question?",
      'wrong-language': "Is the response written in the language of the user's message?",
      'no-order-status': 'Does the message state where the order currently is?',
    };

    const PRESENCE = new Set(['missing-citation', 'wrong-language', 'no-order-status']);

    function observed(stubborn: readonly string[] = []): FakeGenerator {
      let modeCalls = 0;
      const doGenerate = vi.fn<DoGenerate>((req) => {
        const name = req.schema?.name;
        if (name === 'failure_modes') {
          const ids = [...req.prompt.matchAll(/^### trace (\S+)$/gm)].map((m) => m[1] ?? '');
          const modes = modeCalls === 0 ? OBSERVED_MODES.slice(0, 1) : OBSERVED_MODES;
          modeCalls += 1;
          return Promise.resolve({
            value: {
              failureModes: modes.map(([mode, description], i) => ({
                name: mode,
                description,
                exampleTraceIds: [ids[i % ids.length] ?? 'unknown'],
              })),
            },
            resolvedModelId: 'acme/model-1',
          });
        }
        const repair = req.system !== undefined && !req.system.startsWith(CRITERIA_PROMPT);
        const named = OBSERVED_MODES.map(([mode]) => mode).filter((mode) =>
          req.prompt.includes(mode),
        );
        return Promise.resolve({
          value: {
            criteria: named.map((mode) => {
              const fixed = repair && !stubborn.includes(mode);
              return {
                failureMode: mode,
                instructions: (fixed ? POSITIVE : INVERTED)[mode],
                escape: 'The response is missing or empty.',
                polarity: fixed && PRESENCE.has(mode) ? 'pass_when_true' : 'pass_when_false',
                channel: 'quality',
                checkable: 'none',
              };
            }),
          },
          resolvedModelId: 'acme/model-1',
        });
      });
      const generator: GeneratorV1 = {
        specVersion: 'v1',
        id: 'fake-gen',
        capabilities: { structured: 'json_schema', streaming: false },
        doGenerate,
      };
      return { generator, doGenerate };
    }

    const FIFTY = Array.from({ length: 50 }, (_, i) => trace(`t${String(i).padStart(2, '0')}`));

    test('yields at least 5 atomic criteria with escape options and provenance', async () => {
      const { generator, doGenerate } = observed();
      const { judge } = fakeJudge(0.9, 'none');

      const { criteria, report } = await generateEvals({
        source: fakeSource(FIFTY),
        generator,
        judge,
        out,
        overwrite: false,
      });

      expect(report.status).toBe('ok');
      expect(report.failureModes.length).toBeGreaterThanOrEqual(5);
      expect(criteria.length).toBeGreaterThanOrEqual(5);
      for (const c of criteria) {
        expect((c.escape ?? '').trim()).not.toBe('');
        expect(c.provenance.traceIds.length).toBeGreaterThan(0);
        expect(c.provenance.generator).toMatch(/^acme\/model-1#[0-9a-f]{64}$/);
      }
      expect(report.rejected).toEqual([]);
      expect(report.repaired.length).toBeGreaterThanOrEqual(5);
      expect(report.dropped).toBe(0);
      expect(doGenerate.mock.calls.length).toBeLessThanOrEqual(3 + Math.ceil(FIFTY.length / 20));
    });

    test('a draft the repair cannot fix is dropped and counted in the report', async () => {
      const { generator } = observed(['leaks-pii']);
      const { judge } = fakeJudge(0.9, 'none');

      const { criteria, report } = await generateEvals({
        source: fakeSource(FIFTY),
        generator,
        judge,
        out,
        overwrite: false,
      });

      expect(criteria.map((c) => c.id)).not.toContain('leaks-pii');
      expect(criteria.length).toBeGreaterThanOrEqual(5);
      expect(report.dropped).toBe(1);
      expect(report.rejected).toContainEqual(
        expect.objectContaining({ criterionId: 'leaks-pii', ruleId: 'INVERTED_BOOLEAN' }),
      );
    });
  });
});
