import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import type { Trace } from './corpus.ts';
import type { Criterion } from './propose.ts';
import {
  CSV_HEADER,
  buildPendingItems,
  buildQueue,
  compareAnswerToReference,
  computeC2Label,
  computeC3Baseline,
  importModelRows,
  isAbstention,
  mergeImport,
  parseCsv,
  resolveMode,
  runAuto,
  runInteractiveLoop,
  seededShuffle,
  selectSample,
  serializeRow,
  validateImportRow,
  type LabelRow,
} from './label.ts';

const LABEL_TS_PATH = fileURLToPath(new URL('./label.ts', import.meta.url));

function trace(overrides: Partial<Trace>): Trace {
  return {
    traceId: 't1',
    variant: 'bm25',
    goldenId: 'g1',
    lang: 'en',
    hops: 1,
    unanswerable: false,
    question: 'Q?',
    answer: 'A.',
    contexts: [{ docId: 'd1.pdf', text: 'context text' }],
    reference: 'ref',
    baseline: { faithfulness: 1, context_relevance: 1, judgeModel: 'gemini-3.1-pro-preview' },
    retrievedIds: ['d1.pdf'],
    langfuseTraceId: 'lf-1',
    ...overrides,
  };
}

function criterion(overrides: Partial<Criterion>): Criterion {
  return {
    id: 'c4',
    name: 'Hallucinated factual claims',
    instructions: 'Does the answer hallucinate?',
    escape: 'No factual assertions',
    provenance: null,
    ...overrides,
  };
}

describe('compareAnswerToReference (unit, real corpus values)', () => {
  test('exact match after normalisation -> yes', () => {
    expect(
      compareAnswerToReference('The Velmoor Water Authority was founded in 1974 [1].', '1974'),
    ).toBe('yes');
  });

  test('number-format mismatch (words vs digit-grouped symbol) -> review', () => {
    expect(
      compareAnswerToReference(
        'The reservoir stores 42,000,000 m³ of water.',
        '42 million cubic metres',
      ),
    ).toBe('review');
  });

  test('Kazakh reference round-trips through normalisation -> yes (real corpus row kk01-f3)', () => {
    expect(
      compareAnswerToReference(
        'Көкжиек ауылындағы мектептің директоры — Сәуле Оспанова [1].',
        'Сәуле Оспанова',
      ),
    ).toBe('yes');
  });

  test('no shared content or numbers -> no', () => {
    expect(compareAnswerToReference('The capital is Astana.', '1974')).toBe('no');
  });

  test('null reference (unanswerable row) -> review (escape: reference not comparable)', () => {
    expect(compareAnswerToReference('There is no evidence in the documents.', null)).toBe('review');
  });
});

describe('isAbstention (unit, ported from haystack-hypothesis src/probe/eval_judge.py)', () => {
  test('matches an English abstention phrase (real corpus row un-en-01)', () => {
    expect(
      isAbstention(
        'There is no evidence in the provided documents regarding the annual budget of the Velmoor Water Authority.',
      ),
    ).toBe(true);
  });

  test('matches a Kazakh abstention phrase (real corpus row un-kk-01)', () => {
    expect(
      isAbstention(
        'Ұсынылған құжаттарда Көкжиек ауылындағы мектептің жылдық бюджеті туралы ақпарат жоқ.',
      ),
    ).toBe(true);
  });

  test('does not match an ordinary factual answer', () => {
    expect(isAbstention('The Velmoor Water Authority was founded in 1974.')).toBe(false);
  });
});

describe('computeC2Label (unit)', () => {
  test('unanswerable and abstains -> yes', () => {
    expect(computeC2Label('no information is available', true)).toBe('yes');
  });

  test('unanswerable and does not abstain -> no', () => {
    expect(computeC2Label('It was founded in 1974.', true)).toBe('no');
  });

  test('answerable and does not abstain -> yes', () => {
    expect(computeC2Label('It was founded in 1974.', false)).toBe('yes');
  });

  test('answerable but abstains -> no', () => {
    expect(computeC2Label('no information is available', false)).toBe('no');
  });
});

describe('computeC3Baseline (unit)', () => {
  test('faithfulness 1 -> yes, baseline "1"', () => {
    expect(computeC3Baseline(1)).toEqual({ label: 'yes', baseline: '1' });
  });

  test('faithfulness below 0.5 -> no', () => {
    expect(computeC3Baseline(0.3)).toEqual({ label: 'no', baseline: '0.3' });
  });

  test('faithfulness exactly 0.5 -> yes (boundary)', () => {
    expect(computeC3Baseline(0.5).label).toBe('yes');
  });
});

describe('CSV serialize/parse round trip (unit)', () => {
  test('serializeRow then parseCsv reconstructs the row', () => {
    const row: LabelRow = {
      traceId: 'bm25:en01-f1',
      criterionId: 'c1',
      label: 'yes',
      source: 'auto',
      labelledAt: '2026-09-26T00:00:00.000Z',
      baseline: '',
    };
    const text = `${CSV_HEADER}\n${serializeRow(row)}\n`;
    expect(parseCsv(text)).toEqual([row]);
  });

  test('skips blank lines and malformed rows', () => {
    const text = `${CSV_HEADER}\n\nnotEnoughColumns\nbm25:x,c1,bogus-label,auto,2026-09-26T00:00:00.000Z,\n`;
    expect(parseCsv(text)).toEqual([]);
  });
});

describe('runAuto (unit)', () => {
  const traces: Trace[] = [
    trace({
      traceId: 'bm25:en01-f1',
      lang: 'en',
      unanswerable: false,
      reference: '1974',
      answer: 'The Velmoor Water Authority was founded in 1974 [1].',
      baseline: { faithfulness: 1, context_relevance: 1, judgeModel: 'gemini-3.1-pro-preview' },
    }),
    trace({
      traceId: 'bm25:un-en-01',
      lang: 'en',
      unanswerable: true,
      reference: null,
      answer: 'There is no evidence in the provided documents.',
      baseline: { faithfulness: 1, context_relevance: 1, judgeModel: 'gemini-3.1-pro-preview' },
    }),
  ];

  test('produces c1/c2/c3 rows for every trace with matching counts', () => {
    const { rows, counts } = runAuto(traces, []);
    expect(rows).toHaveLength(6);
    expect(counts).toEqual({ c1: { yes: 1, no: 0, review: 1 }, c2: { yes: 2, no: 0 }, c3: 1 + 1 });
  });

  test('is idempotent: rerunning with the previous rows as existing writes nothing new', () => {
    const first = runAuto(traces, []);
    const second = runAuto(traces, first.rows);
    expect(second.rows).toHaveLength(0);
    expect(second.counts).toEqual(first.counts);
  });
});

describe('seededShuffle (unit)', () => {
  test('same seed produces the same order', () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    expect(seededShuffle(items, 42)).toEqual(seededShuffle(items, 42));
  });

  test('reorders (does not just return the identity order)', () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    expect(seededShuffle(items, 42)).not.toEqual(items);
  });
});

describe('selectSample (unit)', () => {
  const traces: Trace[] = ['en', 'ru', 'kk'].flatMap((lang) =>
    Array.from({ length: 4 }, (_, i) => trace({ traceId: `${lang}-${i}`, lang })),
  );

  test('returns at least minSize ids spanning every language present', () => {
    const sample = selectSample(traces, 7, 6);
    expect(sample.length).toBeGreaterThanOrEqual(6);
    const langsInSample = new Set(sample.map((id) => id.split('-')[0]));
    expect(langsInSample).toEqual(new Set(['en', 'ru', 'kk']));
  });
});

describe('buildQueue (unit)', () => {
  const traces: Trace[] = [
    trace({ traceId: 'a', lang: 'en' }),
    trace({ traceId: 'b', lang: 'en' }),
  ];
  const criteria: Criterion[] = [
    criterion({ id: 'c1', name: 'answer_correct' }),
    criterion({ id: 'c2', name: 'abstains_when_unanswerable' }),
    criterion({ id: 'c3', name: 'faithful_to_context' }),
    criterion({ id: 'c4', name: 'Hallucinated factual claims' }),
  ];

  test('queues unresolved c1 review rows before sampled c3/generated rows', () => {
    const existing: LabelRow[] = [
      {
        traceId: 'a',
        criterionId: 'c1',
        label: 'review',
        source: 'auto',
        labelledAt: 't',
        baseline: '',
      },
      {
        traceId: 'b',
        criterionId: 'c1',
        label: 'yes',
        source: 'auto',
        labelledAt: 't',
        baseline: '',
      },
    ];
    const queue = buildQueue(traces, criteria, existing, ['b']);
    expect(queue).toEqual([
      { traceId: 'a', criterionId: 'c1' },
      { traceId: 'b', criterionId: 'c3' },
      { traceId: 'b', criterionId: 'c4' },
    ]);
  });

  test('excludes pairs that already have a human label', () => {
    const existing: LabelRow[] = [
      {
        traceId: 'a',
        criterionId: 'c1',
        label: 'review',
        source: 'auto',
        labelledAt: 't',
        baseline: '',
      },
      {
        traceId: 'a',
        criterionId: 'c1',
        label: 'no',
        source: 'human',
        labelledAt: 't',
        baseline: '',
      },
    ];
    const queue = buildQueue(traces, criteria, existing, []);
    expect(queue).toEqual([]);
  });
});

describe('runInteractiveLoop (unit, scripted answers, no real stdin/TTY)', () => {
  const traces: Trace[] = [trace({ traceId: 'a', question: 'Q-a?', answer: 'A-a.' })];
  const criteria: Criterion[] = [criterion({ id: 'c4' })];

  test('drives y/n answers to rows and stops without writing on q', async () => {
    const answers = ['y', 'q'];
    const rows: LabelRow[] = [];
    const printed: string[] = [];
    const queue = [
      { traceId: 'a', criterionId: 'c4' },
      { traceId: 'a', criterionId: 'c4' },
    ];

    const result = await runInteractiveLoop({
      queue,
      traces,
      criteria,
      ask: async () => answers.shift() ?? '',
      print: (m) => printed.push(m),
      onRow: (r) => rows.push(r),
      now: () => 'FIXED_TIME',
    });

    expect(result).toEqual({ answered: 1, quit: true });
    expect(rows).toEqual([
      {
        traceId: 'a',
        criterionId: 'c4',
        label: 'yes',
        source: 'human',
        labelledAt: 'FIXED_TIME',
        baseline: '',
      },
    ]);
  });

  test('never prints the baseline faithfulness score or reads verdicts.jsonl (blind)', async () => {
    const printed: string[] = [];
    await runInteractiveLoop({
      queue: [{ traceId: 'a', criterionId: 'c4' }],
      traces: [
        trace({
          traceId: 'a',
          baseline: { faithfulness: 0.987654, context_relevance: 1, judgeModel: 'x' },
        }),
      ],
      criteria,
      ask: async () => 'n',
      print: (m) => printed.push(m),
      onRow: () => {},
    });

    expect(printed.some((m) => m.includes('0.987654'))).toBe(false);
    expect(printed.some((m) => /faithful/i.test(m))).toBe(false);

    const source = readFileSync(LABEL_TS_PATH, 'utf8');
    expect(source.includes('verdicts.jsonl')).toBe(false);
  });
});

describe('mergeImport / validateImportRow (unit)', () => {
  const traceIds = new Set(['a', 'b']);
  const criterionIds = new Set(['c1', 'c4']);

  test('rejects a row with an invalid label', () => {
    const bad: LabelRow = JSON.parse(
      JSON.stringify({
        traceId: 'a',
        criterionId: 'c1',
        label: 'bogus',
        source: 'human',
        labelledAt: 't',
        baseline: '',
      }),
    );
    expect(validateImportRow(bad, traceIds, criterionIds)).toBe(false);
  });

  test('rejects a row with an unknown traceId', () => {
    const bad: LabelRow = {
      traceId: 'unknown',
      criterionId: 'c1',
      label: 'yes',
      source: 'human',
      labelledAt: 't',
      baseline: '',
    };
    expect(validateImportRow(bad, traceIds, criterionIds)).toBe(false);
  });

  test('imports the good rows and counts the one bad row as rejected', () => {
    const good1: LabelRow = {
      traceId: 'a',
      criterionId: 'c1',
      label: 'yes',
      source: 'human',
      labelledAt: 't1',
      baseline: '',
    };
    const good2: LabelRow = {
      traceId: 'b',
      criterionId: 'c4',
      label: 'no',
      source: 'human',
      labelledAt: 't2',
      baseline: '',
    };
    const bad: LabelRow = JSON.parse(
      JSON.stringify({
        traceId: 'a',
        criterionId: 'c1',
        label: 'maybe',
        source: 'human',
        labelledAt: 't3',
        baseline: '',
      }),
    );

    const { toAppend, imported, rejected } = mergeImport(
      [good1, bad, good2],
      [],
      traceIds,
      criterionIds,
    );

    expect(rejected).toBe(1);
    expect(imported).toBe(2);
    expect(toAppend).toEqual([good1, good2]);
  });

  test('does not re-append a triple already present in existing rows', () => {
    const row: LabelRow = {
      traceId: 'a',
      criterionId: 'c1',
      label: 'yes',
      source: 'human',
      labelledAt: 't1',
      baseline: '',
    };
    const { toAppend, imported } = mergeImport([row], [row], traceIds, criterionIds);
    expect(toAppend).toEqual([]);
    expect(imported).toBe(0);
  });
});

describe('resolveMode (unit)', () => {
  test('--auto wins regardless of TTY', () => {
    expect(resolveMode(['--auto'], false)).toEqual({ mode: 'auto' });
  });

  test('--import <path> resolves to import mode with the path', () => {
    expect(resolveMode(['--import', 'x.csv'], false)).toEqual({ mode: 'import', path: 'x.csv' });
  });

  test('--import with no path exits 2', () => {
    expect(resolveMode(['--import'], true)).toEqual({ mode: 'exit2' });
  });

  test('no flags and a TTY -> interactive', () => {
    expect(resolveMode([], true)).toEqual({ mode: 'interactive' });
  });

  test('no flags and no TTY -> exit2', () => {
    expect(resolveMode([], false)).toEqual({ mode: 'exit2' });
  });
});

describe('CLI non-TTY exit (subprocess, no network)', () => {
  test('bun spike/label.ts with no flags and non-TTY stdin exits 2 without hanging', () => {
    let status = 0;
    try {
      execFileSync('bun', ['spike/label.ts'], {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        stdio: ['ignore', 'ignore', 'ignore'],
        timeout: 10_000,
      });
    } catch (err) {
      if (err instanceof Error && 'status' in err && typeof err.status === 'number')
        status = err.status;
    }
    expect(status).toBe(2);
  });
});

const auto = (traceId: string, label: 'review' | 'yes'): LabelRow => ({
  traceId,
  criterionId: 'c1',
  label,
  source: 'auto',
  labelledAt: 't',
  baseline: 'SECRET-BASELINE',
});

describe('model labels: blind export', () => {
  const traces = [
    trace({ traceId: 'a', lang: 'ru', reference: 'SECRET-REF' }),
    trace({ traceId: 'b', lang: 'kk' }),
  ];
  const criteria = [
    criterion({ id: 'c1', name: 'Answer correct', instructions: 'ok?' }),
    criterion({ id: 'c4', name: 'Hallucination', instructions: 'halluc?', escape: 'none' }),
  ];
  test('items match the loop queue and carry only what a human sees', () => {
    const existing = [auto('a', 'review'), auto('b', 'yes')];
    const queue = buildQueue(traces, criteria, existing, ['b']);
    const items = buildPendingItems(traces, criteria, existing, ['b']);
    expect(items.map((i) => i.id)).toEqual(queue.map((q) => `${q.traceId}:${q.criterionId}`));
    expect(items[0]).toEqual({
      id: 'a:c1',
      traceId: 'a',
      criterionId: 'c1',
      question: 'Q?',
      answer: 'A.',
      contexts: [{ docId: 'd1.pdf', text: 'context text' }],
      criterion: { name: 'Answer correct', instructions: 'ok?', escape: 'No factual assertions' },
      labels: ['yes', 'no', 'review'],
    });
    const text = JSON.stringify(items);
    expect(text).not.toContain('SECRET');
    expect(text).not.toContain('baseline');
  });

  test('items already labelled by model are not re-exported', () => {
    const existing: LabelRow[] = [
      auto('a', 'review'),
      { ...auto('a', 'review'), source: 'model', label: 'yes', baseline: '' },
    ];
    expect(buildPendingItems(traces, criteria, existing, []).map((i) => i.id)).toEqual([]);
  });
});

const now = () => '2026-09-29T00:00:00.000Z';
const line = (o: object) => JSON.stringify(o);

describe('model labels: import', () => {
  const pending = new Set(['a:c1', 'b:c4']);
  test('appends valid rows as source model with current labelledAt', () => {
    const text = line({ id: 'a:c1', label: 'yes' }) + '\n' + line({ id: 'b:c4', label: 'review' });
    const r = importModelRows(text, pending, [], now);
    expect(r.toAppend).toEqual([
      {
        traceId: 'a',
        criterionId: 'c1',
        label: 'yes',
        source: 'model',
        labelledAt: now(),
        baseline: '',
      },
      {
        traceId: 'b',
        criterionId: 'c4',
        label: 'review',
        source: 'model',
        labelledAt: now(),
        baseline: '',
      },
    ]);
    expect(r.rejected).toBe(0);
  });

  test('rejects unknown ids, unknown labels, source human, bad json', () => {
    const text = [
      line({ id: 'zzz:c1', label: 'yes' }),
      line({ id: 'a:c1', label: 'maybe' }),
      line({ id: 'a:c1', label: 'yes', source: 'human' }),
      '{not json',
    ].join('\n');
    const r = importModelRows(text, pending, [], now);
    expect(r.toAppend).toEqual([]);
    expect(r.rejected).toBe(4);
  });

  test('idempotent: ids already labelled by model are skipped, not rejected', () => {
    const existing: LabelRow[] = [
      {
        traceId: 'a',
        criterionId: 'c1',
        label: 'no',
        source: 'model',
        labelledAt: 't',
        baseline: '',
      },
    ];
    const r = importModelRows(line({ id: 'a:c1', label: 'yes' }), pending, existing, now);
    expect(r.toAppend).toEqual([]);
    expect(r.skipped).toBe(1);
    expect(r.rejected).toBe(0);
  });
});

describe('resolveMode: model labels', () => {
  test('--export-pending <file>', () => {
    expect(resolveMode(['--export-pending', 'p.jsonl'], false)).toEqual({
      mode: 'export-pending',
      path: 'p.jsonl',
    });
    expect(resolveMode(['--export-pending'], false)).toEqual({ mode: 'exit2' });
  });

  test('--import <file> --source model routes to model import; other sources exit 2', () => {
    expect(resolveMode(['--import', 'm.jsonl', '--source', 'model'], false)).toEqual({
      mode: 'import-model',
      path: 'm.jsonl',
    });
    expect(resolveMode(['--import', 'm.jsonl', '--source', 'human'], false)).toEqual({
      mode: 'exit2',
    });
  });
});
