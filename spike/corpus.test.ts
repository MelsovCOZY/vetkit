import { describe, expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildTraces, type GoldenRow, type Report } from './corpus.ts';

const CORPUS_TS_PATH = fileURLToPath(new URL('./corpus.ts', import.meta.url));
const TRACES_PATH = fileURLToPath(new URL('./data/traces.jsonl', import.meta.url));
const CORPUS_TEXT_PATH = fileURLToPath(new URL('./data/corpus-text.json', import.meta.url));

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function report(variant: string, rows: Report['per_question']): Record<string, Report> {
  return { [variant]: { variant, per_question: rows, failed: [] } };
}

describe('buildTraces (unit, fixtures only)', () => {
  const golden: GoldenRow[] = [
    {
      id: 'en01-f1',
      lang: 'en',
      question: 'Q1?',
      relevant_doc_ids: ['doc1.pdf'],
      reference_answer: 'answer one',
      hops: 1,
    },
    {
      id: 'un-en-01',
      lang: 'en',
      question: 'Unanswerable?',
      relevant_doc_ids: [],
      reference_answer: null,
      hops: 1,
    },
  ];
  const corpusText = { 'doc1.pdf': 'the text of doc one' };

  test('throws naming the retrieved id when its text is missing from the corpus', () => {
    const reports = report('bm25', [
      {
        id: 'en01-f1',
        lang: 'en',
        answer: 'a1',
        trace_id: 't1',
        retrieved_ids: ['missing.pdf'],
        scores: { faithfulness: 1, context_relevance: 1 },
      },
    ]);

    expect(() => buildTraces(golden, reports, corpusText)).toThrow(/missing\.pdf/);
  });

  test('marks a row unanswerable when its golden relevant_doc_ids is empty, with a null reference', () => {
    const reports = report('bm25', [
      {
        id: 'un-en-01',
        lang: 'en',
        answer: 'I do not know',
        trace_id: 't2',
        retrieved_ids: [],
        scores: { faithfulness: 1, context_relevance: 1 },
      },
    ]);

    const [trace] = buildTraces(golden, reports, corpusText);

    expect(trace?.unanswerable).toBe(true);
    expect(trace?.reference).toBeNull();
  });

  test('builds an answerable trace with resolved contexts, baseline scores and camelCased ids', () => {
    const reports = report('hybrid', [
      {
        id: 'en01-f1',
        lang: 'en',
        answer: 'The answer is one.',
        trace_id: 'lf-trace-1',
        retrieved_ids: ['doc1.pdf'],
        scores: { faithfulness: 0.9, context_relevance: 0.8 },
      },
    ]);

    const [trace] = buildTraces(golden, reports, corpusText);

    expect(trace).toEqual({
      traceId: 'hybrid:en01-f1',
      variant: 'hybrid',
      goldenId: 'en01-f1',
      lang: 'en',
      hops: 1,
      unanswerable: false,
      question: 'Q1?',
      answer: 'The answer is one.',
      contexts: [{ docId: 'doc1.pdf', text: 'the text of doc one' }],
      reference: 'answer one',
      baseline: { faithfulness: 0.9, context_relevance: 0.8, judgeModel: 'gemini-3.1-pro-preview' },
      retrievedIds: ['doc1.pdf'],
      langfuseTraceId: 'lf-trace-1',
    });
  });

  test('throws naming the golden id when a report row has no matching golden entry', () => {
    const reports = report('bm25', [
      {
        id: 'no-such-id',
        lang: 'en',
        answer: 'a',
        trace_id: 't3',
        retrieved_ids: [],
        scores: { faithfulness: 1, context_relevance: 1 },
      },
    ]);

    expect(() => buildTraces(golden, reports, corpusText)).toThrow(/no-such-id/);
  });
});

describe('generated spike/data/traces.jsonl (integration, real haystack-hypothesis corpus)', () => {
  test('has 456 rows, 38/38/38 per language per variant, 6 unanswerable per variant, every retrievedId resolved to text', async () => {
    const raw = await readFile(TRACES_PATH, 'utf8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(456);

    const rows = lines.map((line) => JSON.parse(line));

    const variants = ['bm25', 'embedding', 'hybrid', 'hybrid-norerank'];
    for (const variant of variants) {
      const forVariant = rows.filter((r) => r.variant === variant);
      expect(forVariant).toHaveLength(114);

      const perLang: Record<string, number> = {};
      for (const r of forVariant) perLang[r.lang] = (perLang[r.lang] ?? 0) + 1;
      expect(perLang).toEqual({ en: 38, ru: 38, kk: 38 });

      const unanswerable = forVariant.filter((r) => r.unanswerable === true);
      expect(unanswerable).toHaveLength(6);
    }

    for (const row of rows) {
      expect(row.contexts).toHaveLength(row.retrievedIds.length);
      for (const ctx of row.contexts) {
        expect(typeof ctx.text).toBe('string');
        expect(ctx.text.length).toBeGreaterThan(0);
      }
    }
  });

  test('reference is null only for unanswerable rows', async () => {
    const raw = await readFile(TRACES_PATH, 'utf8');
    const rows = raw
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));

    for (const row of rows) {
      if (row.unanswerable) {
        expect(row.reference).toBeNull();
      } else {
        expect(row.reference).not.toBeNull();
      }
    }
  });

  test('a known Cyrillic reference answer survives the extraction round trip', async () => {
    const raw = await readFile(TRACES_PATH, 'utf8');
    const rows = raw
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));

    const row = rows.find((r) => r.goldenId === 'ru01-f2');
    expect(row).toBeDefined();
    expect(row?.reference).toBe('3,2 миллиона тонн');
  });
});

describe('generated spike/data/corpus-text.json (integration, produced by extract_corpus.py)', () => {
  test('has 48 keys, each with at least 50 words', async () => {
    const raw = await readFile(CORPUS_TEXT_PATH, 'utf8');
    const corpusText: Record<string, string> = JSON.parse(raw);

    const keys = Object.keys(corpusText);
    expect(keys).toHaveLength(48);

    for (const key of keys) {
      expect(wordCount(corpusText[key] ?? '')).toBeGreaterThanOrEqual(50);
    }
  });
});

describe('spike/corpus.ts never touches env files or Langfuse', () => {
  test('source contains no reference to a .env file or LANGFUSE (process.env var access is fine)', async () => {
    const source = await readFile(CORPUS_TS_PATH, 'utf8');
    const nonEnvVarLines = source.split('\n').filter((line) => !line.includes('process.env'));
    const suspectDotEnvLines = nonEnvVarLines.filter((line) => line.includes('.env'));
    expect(suspectDotEnvLines).toEqual([]);
    expect(source).not.toMatch(/LANGFUSE/);
  });
});
