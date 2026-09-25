import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readJsonl, writeJsonl } from './lib/index.ts';

const VARIANTS = ['bm25', 'embedding', 'hybrid', 'hybrid-norerank'] as const;
type Variant = (typeof VARIANTS)[number];

export type GoldenRow = {
  id: string;
  lang: string;
  question: string;
  relevant_doc_ids: string[];
  reference_answer: string | null;
  hops: number;
};

export type ReportRow = {
  id: string;
  lang: string;
  answer: string;
  trace_id: string;
  retrieved_ids: string[];
  scores: { faithfulness: number; context_relevance: number };
};

export type Report = {
  variant: string;
  per_question: ReportRow[];
  failed: unknown[];
};

export type Trace = {
  traceId: string;
  variant: string;
  goldenId: string;
  lang: string;
  hops: number;
  unanswerable: boolean;
  question: string;
  answer: string;
  contexts: { docId: string; text: string }[];
  reference: string | null;
  baseline: { faithfulness: number; context_relevance: number; judgeModel: string };
  retrievedIds: string[];
  langfuseTraceId: string;
};

const JUDGE_MODEL = 'gemini-3.1-pro-preview';

/** Joins golden questions with per-variant report rows and rebuilt corpus contexts into traces. */
export function buildTraces(
  golden: GoldenRow[],
  reports: Record<string, Report>,
  corpusText: Record<string, string>,
): Trace[] {
  const goldenById = new Map(golden.map((g) => [g.id, g] as const));
  const traces: Trace[] = [];

  for (const variant of Object.keys(reports)) {
    const report = reports[variant]!;
    for (const row of report.per_question) {
      const goldenRow = goldenById.get(row.id);
      if (!goldenRow) {
        throw new Error(`corpus.ts: golden entry not found for report row id: ${row.id}`);
      }

      const contexts = row.retrieved_ids.map((docId) => {
        const text = corpusText[docId];
        if (text === undefined) {
          throw new Error(`corpus.ts: corpus text missing for retrieved docId: ${docId}`);
        }
        return { docId, text };
      });

      traces.push({
        traceId: `${variant}:${row.id}`,
        variant,
        goldenId: row.id,
        lang: row.lang,
        hops: goldenRow.hops,
        unanswerable: goldenRow.relevant_doc_ids.length === 0,
        question: goldenRow.question,
        answer: row.answer,
        contexts,
        reference: goldenRow.reference_answer,
        baseline: {
          faithfulness: row.scores.faithfulness,
          context_relevance: row.scores.context_relevance,
          judgeModel: JUDGE_MODEL,
        },
        retrievedIds: row.retrieved_ids,
        langfuseTraceId: row.trace_id,
      });
    }
  }

  return traces;
}

async function main(): Promise<void> {
  const haystackDir = process.env.HAYSTACK_HYPOTHESIS_DIR ?? join(homedir(), 'Projects', 'haystack-hypothesis');
  const spikeDataDir = fileURLToPath(new URL('./data/', import.meta.url));

  const golden = await readJsonl<GoldenRow>(join(haystackDir, 'golden', 'golden.jsonl'));
  const corpusText: Record<string, string> = JSON.parse(
    await readFile(join(spikeDataDir, 'corpus-text.json'), 'utf8'),
  );

  const reports: Record<Variant, Report> = {} as Record<Variant, Report>;
  for (const variant of VARIANTS) {
    const report: Report = JSON.parse(
      await readFile(join(haystackDir, 'report', `eval-${variant}.json`), 'utf8'),
    );
    reports[variant] = report;
    if (report.failed.length > 0) {
      console.log(`corpus.ts: variant ${variant} skipped ${report.failed.length} failed row(s)`);
    }
  }

  const traces = buildTraces(golden, reports, corpusText);
  await writeJsonl(join(spikeDataDir, 'traces.jsonl'), traces);
  console.log(`corpus.ts: wrote ${traces.length} traces to spike/data/traces.jsonl`);
}

if (import.meta.main) {
  await main();
}
