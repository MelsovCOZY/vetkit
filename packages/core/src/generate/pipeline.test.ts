// Tests for the J2 generation pipeline and its two steps (case extraction, Jev dedupe).
// All three live here because this bead's owned paths name only pipeline.test.ts.
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
  type Question,
  type SourceV1,
} from '@vetkit/spec';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { loadCases, MAX_STATE_TOKENS } from '../cases/load.ts';
import { computeWordingHash, loadCriteria } from '../criteria/load.ts';
import { extractCases } from './cases.ts';
import { dedupeCriteria } from './dedupe.ts';
import { generateEvals } from './pipeline.ts';

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

interface CandidateExtra {
  readonly channel?: Criterion['channel'];
  readonly provenance?: Criterion['provenance'];
}

function candidate(id: string, instructions: string, extra: CandidateExtra = {}): Criterion {
  const escape = 'The response is missing or empty.';
  return {
    id,
    type: 'boolean',
    instructions,
    escape,
    polarity: 'pass_when_false',
    channel: 'quality',
    provenance: { traceIds: [`${id}-trace`], generator: 'acme/model-1#hash' },
    wordingHash: computeWordingHash({ type: 'boolean', instructions, escape }),
    ...extra,
  };
}

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

function choiceQuestions(
  req: JudgeRequest | undefined,
): Array<Extract<Question, { type: 'choice' }>> {
  return Object.values(req?.questions ?? {}).filter(
    (q): q is Extract<Question, { type: 'choice' }> => q.type === 'choice',
  );
}

// ---------------------------------------------------------------- extractCases

describe('extractCases', () => {
  test('renders a trace as role: content lines and sets the final assistant answer', () => {
    const { cases } = extractCases({ traces: [trace('t1')], criteria: [] });

    expect(cases).toHaveLength(1);
    const c = cases[0];
    expect(c?.input.state).toBe(
      [
        'system: You are a support agent.',
        'user: Where is order t1?',
        'assistant: Order t1 ships today.',
      ].join('\n'),
    );
    expect(c?.input.answer).toBe('Order t1 ships today.');
    expect(c?.traceId).toBe('t1');
    expect(c?.provenance).toEqual({ traceIds: ['t1'] });
    expect(c?.tags).not.toContain('truncated');
  });

  test('inlines tool calls and tool responses as JSON', () => {
    const t = trace('t2', {
      messages: [
        { role: 'user', parts: [{ type: 'text', content: 'Status of A1?' }] },
        {
          role: 'assistant',
          parts: [
            { type: 'tool_call', id: 'c1', name: 'lookup_order', arguments: { orderId: 'A1' } },
          ],
        },
        {
          role: 'tool',
          parts: [{ type: 'tool_call_response', id: 'c1', response: { status: 'shipped' } }],
        },
        { role: 'assistant', parts: [{ type: 'text', content: 'A1 has shipped.' }] },
      ],
    });

    const state = extractCases({ traces: [t], criteria: [] }).cases[0]?.input.state ?? '';

    expect(state).toContain('assistant: {');
    expect(state).toContain('"lookup_order"');
    expect(state).toContain('"orderId":"A1"');
    expect(state).toContain('tool: {');
    expect(state).toContain('"status":"shipped"');
    expect(state.endsWith('assistant: A1 has shipped.')).toBe(true);
  });

  test('is deterministic: same trace gives the same id and state; ids are sha256 hex per trace', () => {
    const a = extractCases({ traces: [trace('t1'), trace('t2')], criteria: [] }).cases;
    const b = extractCases({ traces: [trace('t1'), trace('t2')], criteria: [] }).cases;

    expect(a).toEqual(b);
    expect(a[0]?.id).toMatch(/^[0-9a-f]{64}$/);
    expect(a[0]?.id).not.toBe(a[1]?.id);
  });

  test('skips a trace whose content was not captured, reporting not_applicable', () => {
    const { cases, traces } = extractCases({
      traces: [uncaptured('t-none'), trace('t1')],
      criteria: [],
    });

    expect(cases.map((c) => c.traceId)).toEqual(['t1']);
    expect(traces).toContainEqual(
      expect.objectContaining({ traceId: 't-none', status: 'not_applicable' }),
    );
    expect(traces).toContainEqual(expect.objectContaining({ traceId: 't1', status: 'ok' }));
  });

  test('a trace with only system messages is not_applicable', () => {
    const t = trace('t-sys', {
      messages: [{ role: 'system', parts: [{ type: 'text', content: 'You are helpful.' }] }],
    });

    const { cases, traces } = extractCases({ traces: [t], criteria: [] });

    expect(cases).toHaveLength(0);
    expect(traces).toContainEqual(
      expect.objectContaining({ traceId: 't-sys', status: 'not_applicable' }),
    );
  });

  test('caps state at MAX_STATE_TOKENS (chars/4), keeps the end, and flags truncated', () => {
    const t = trace('t-big', {
      messages: [
        {
          role: 'user',
          parts: [{ type: 'text', content: 'x'.repeat(MAX_STATE_TOKENS * 4 + 5000) }],
        },
        { role: 'assistant', parts: [{ type: 'text', content: 'Final answer.' }] },
      ],
    });

    const { cases, traces } = extractCases({ traces: [t], criteria: [] });

    const c = cases[0];
    expect(Math.ceil((c?.input.state.length ?? Infinity) / 4)).toBeLessThanOrEqual(
      MAX_STATE_TOKENS,
    );
    expect(c?.input.state.endsWith('assistant: Final answer.')).toBe(true);
    expect(c?.tags).toContain('truncated');
    expect(c?.input.answer).toBe('Final answer.');
    expect(traces).toContainEqual(
      expect.objectContaining({ traceId: 't-big', status: 'truncated' }),
    );
  });

  test('never writes expected on any generated case', () => {
    const noAnswer = trace('t-q', {
      messages: [{ role: 'user', parts: [{ type: 'text', content: 'Hello?' }] }],
    });
    const { cases } = extractCases({ traces: [trace('t1'), noAnswer], criteria: [] });

    expect(cases).toHaveLength(2);
    for (const c of cases) expect(c).not.toHaveProperty('expected');
    expect(cases[1]).not.toHaveProperty('input.answer');
  });
});

// ---------------------------------------------------------------- dedupeCriteria

describe('dedupeCriteria', () => {
  test('5 dissimilar candidates: zero Jev calls, all kept', async () => {
    const { judge, doJudge } = fakeJudge();
    const candidates = DISSIMILAR.map((text, i) => candidate(`c${i}`, text));

    const result = await dedupeCriteria({ judge, candidates });

    expect(doJudge).not.toHaveBeenCalled();
    expect(result.kept.map((c) => c.id)).toEqual(candidates.map((c) => c.id));
    expect(result.duplicates).toEqual([]);
  });

  test('one near-duplicate pair among 5: one call with only that pair and a none escape; duplicate merged', async () => {
    const { judge, doJudge } = fakeJudge(0.9);
    const candidates = [
      candidate('refund', REFUND, { provenance: { traceIds: ['t1', 't2'] } }),
      ...DISSIMILAR.slice(0, 3).map((text, i) => candidate(`c${i}`, text)),
      candidate('refund-2', REFUND_DUP, { provenance: { traceIds: ['t2', 't3'] } }),
    ];

    const result = await dedupeCriteria({ judge, candidates });

    expect(doJudge).toHaveBeenCalledTimes(1);
    const req = doJudge.mock.calls[0]?.[0];
    expect(req?.state).toContain(REFUND);
    expect(req?.state).toContain(REFUND_DUP);
    for (const text of DISSIMILAR.slice(0, 3)) expect(req?.state).not.toContain(text);
    const questions = choiceQuestions(req);
    expect(questions).toHaveLength(1);
    expect(Object.keys(questions[0]?.criteria ?? {})).toContain('none');
    expect(Object.keys(questions[0]?.criteria ?? {})).toContain('refund');

    expect(result.kept.map((c) => c.id)).toEqual(['refund', 'c0', 'c1', 'c2']);
    expect(result.duplicates).toEqual([
      expect.objectContaining({ id: 'refund-2', duplicateOf: 'refund' }),
    ]);
    const refund = result.kept.find((c) => c.id === 'refund');
    expect(refund?.provenance.traceIds).toEqual(['t1', 't2', 't3']);
  });

  test('a duplicate judged below probability 0.8 is kept', async () => {
    const { judge } = fakeJudge(0.7);
    const candidates = [candidate('refund', REFUND), candidate('refund-2', REFUND_DUP)];

    const result = await dedupeCriteria({ judge, candidates });

    expect(result.kept.map((c) => c.id)).toEqual(['refund', 'refund-2']);
    expect(result.duplicates).toEqual([]);
  });

  test('Jev choosing the none escape keeps both', async () => {
    const { judge, doJudge } = fakeJudge(0.95, 'none');
    const candidates = [candidate('refund', REFUND), candidate('refund-2', REFUND_DUP)];

    const result = await dedupeCriteria({ judge, candidates });

    expect(doJudge).toHaveBeenCalledTimes(1);
    expect(result.kept).toHaveLength(2);
  });

  test('identical wording in different channels is never sent to Jev', async () => {
    const { judge, doJudge } = fakeJudge();
    const candidates = [
      candidate('a', REFUND, { channel: 'outcome' }),
      candidate('b', REFUND, { channel: 'quality' }),
    ];

    const result = await dedupeCriteria({ judge, candidates });

    expect(doJudge).not.toHaveBeenCalled();
    expect(result.kept).toHaveLength(2);
  });

  test('a large similar group is batched: at most one call per 50 candidates, ≤50 options each', async () => {
    const { judge, doJudge } = fakeJudge(0.9, 'none');
    const candidates = Array.from({ length: 60 }, (_, i) => candidate(`r${i}`, `${REFUND} (${i})`));

    await dedupeCriteria({ judge, candidates });

    expect(doJudge.mock.calls.length).toBeGreaterThan(0);
    expect(doJudge.mock.calls.length).toBeLessThanOrEqual(Math.ceil(60 / 50));
    for (const [req] of doJudge.mock.calls) {
      for (const q of choiceQuestions(req)) {
        expect(Object.keys(q.criteria).length).toBeLessThanOrEqual(50);
        expect(Object.keys(q.criteria)).toContain('none');
      }
    }
  });
});

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
      expect(c.provenance).toEqual({ traceIds: [expect.any(String)] });
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
});
