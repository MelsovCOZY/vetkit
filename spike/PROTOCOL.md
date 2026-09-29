# Spike protocol — JS: generated criteria vs human labels

Status: protocol for the JS spike, read by `spike/report.ts` for its go/no-go rule and checked by
the `spike` vitest project. One-week throwaway spike that tests whether atomic typed criteria
written by a generator LLM and judged by Jev agree with human labels well enough to gate CI.
Nothing here is reused by `packages/*`.

## Corpus decision

The spike corpus is haystack-hypothesis: existing evals run in plain mode and compared with Jev.
It does not use synthetic customer-support traces.

## Corpus

Source: `~/Projects/haystack-hypothesis`:

- `golden/golden.jsonl` — 114 questions: 38 en / 38 ru / 38 kk, 19 two-hop, 6 unanswerable
  (`un-*` ids) each with a `reference` answer.
- `report/eval-{bm25,embedding,hybrid,hybrid-norerank}.json` — `per_question`: `id`, `lang`,
  `answer`, `trace_id`, `retrieved_ids`, `scores.faithfulness` / `scores.context_relevance` from
  the "plain mode" LLM judge `gemini-3.1-pro-preview`, averaged over 3 repeats, temperature 0.
- 114 × 4 variants = 456 judged answers with ground truth.

Contexts are rebuilt offline from `corpus/*.pdf|docx` by `retrieved_ids` (documents are 55–344
words, median 70; index chunks at 120/20 tokens so whole-doc text ≈ the judged chunks — stated as
a limitation, not fixed) because the local Langfuse 4.43 instance runs in v4 `events_only` mode and
`/api/public/traces` returns 404 (probed 2026-09-25). Extraction uses the haystack venv
(`uv run --frozen python` with `pypdf` + `python-docx`, no new JS deps) and is committed as
`spike/data/corpus-text.json`. Built by `spike/corpus.ts`.

`spike/data/traces.jsonl` row shape (built from the golden/report data above plus
`corpus-text.json`): `question, answer, contexts[{docId,text}], reference, unanswerable, lang,
variant, baseline{faithfulness, context_relevance, judgeModel}`.

Pre-spike artifacts already exist and are reused as-is, not regenerated:
`fixtures/research/jev-haystack/{judge.py,analyze.py,cases.jsonl,verdicts.jsonl}` (the judge and
analysis scripts, the case set and the verdict cache for c1–c3; these tables are done for the
spike).

## Criteria set

10 boolean (noul) criteria per trace. Every criterion carries an explicit escape/unknown option
(Jev shows no abstention unless an escape option exists).

**Fixed (ground truth already known, done before the spike):**

- `c1 answer_correct` — truth = normalised `reference` is a substring of the normalised answer,
  human confirms mismatches.
- `c2 abstains_when_unanswerable` — truth = the golden unanswerable set (`un-*`).
- `c3 faithful_to_context` — baseline = Gemini plain-mode judge score (faithfulness ≥ 0.5); human
  labels collected on ≥30 traces per the Human labels section below.

**Generated (c4–c10, 7 criteria):** proposed by the generator LLM (`spike/propose.ts`) against the
corpus, to test the generation hypothesis proper. Exact wording is a `spike/propose.ts` output, not
fixed by this protocol.

A criterion whose escape option is chosen > 30% of the time is reported as `unanswerable` and
excluded from κ (Edge cases).

## Judge

Jev, via the TypeSafe-compatible Vercel AI Gateway endpoint, model `typesafe-ai/jev`.

- Request: `POST https://ai-gateway.vercel.sh/typesafe/v1/systemone` with
  `{model:'typesafe-ai/jev', state, questions:{<id>:{type:'noul', instructions}}, providerOptions:{gateway:{only:['typesafe-ai'], zeroDataRetention:true}}}`.
  Read `answers.<id>.noul` (verified by probe).
- `providerOptions.gateway.{zeroDataRetention:true, only:['typesafe-ai']}` is honoured — without it
  the gateway plans a second provider hop; always send `only:['typesafe-ai']` (verified by
  probe).
- N=3 repeats per trace × criterion (Jev answers drift run to run, measured).
- One judge request per trace per repeat carries all 10 criteria as parallel questions (Call
  budget).
- Rate limit: 1,200 rpm upstream; throttle to 2 concurrent requests (Edge cases).
- A trace whose `state` exceeds 32k tokens is truncated to the last 24k characters and flagged
  `truncated: true` in the corpus (context rot).

## Generator

Any OpenAI-compatible endpoint (model-agnostic `GeneratorV1`). The spike
uses the gateway's `POST https://ai-gateway.vercel.sh/v1/chat/completions` with
`response_format: {type:'json_schema'}`, model id from `SPIKE_GENERATOR_MODEL` (default
`anthropic/claude-sonnet-5`), never hard-coded in a library.

## Human labels

≥30 traces × 10 criteria, one labeller (with one rater, Krippendorff α degenerates to κ
against the judge — documented in `REPORT.md`, not corrected in this spike; more than
one labeller is out of scope). The label loop must be resumable and take < 1 s per item, or the spike stalls on
the human (the labelling is the user's time).

### Model labels

The remaining labels come from an independent blind model labeller, stored as source `model`
(never `human`). `bun spike/label.ts --export-pending <file>` writes the items the TTY loop would
ask (same selection function) as JSONL: `id` (`traceId:criterionId`), question, answer, contexts,
the criterion wording and the allowed labels; never Jev answers, baseline, auto labels or the
reference. `--import <file> --source model` takes JSONL `{id, label}` lines, rejects unknown ids
and labels, and skips ids already model-labelled. Where both exist for a trace and criterion, the
human row wins over the model row. `report.ts --check-labels` counts human plus model traces and
prints the breakdown, and the report is marked PROVISIONAL (model-labelled) whenever a model row is
used as truth.

## Metrics

Per criterion, at the fitted threshold:

- Cohen's κ and Krippendorff's α (human labels vs Jev).
- TPR and TNR (human labels vs Jev).
- Boolean flip rate across the 3 repeats.

Additionally, for the haystack-hypothesis corpus:

- Jev `answer_correct` accuracy against the golden `reference` answers.
- Jev vs the Gemini plain-mode judge, κ on faithfulness, broken down per language (including Kazakh).
- Cost: Jev input tokens × $0.042/M vs `judge_prompt_tokens` (757k–850k per variant, recorded in
  the haystack eval reports).

## Go/no-go rule (the spike's deliverable; parseable)

```
GO     if (criteria with κ >= 0.6 AND TPR >= 0.8 AND TNR >= 0.8 on the labelled set) >= 7 of 10
       AND boolean flip rate at threshold <= 5%
AMEND  if 4 <= (criteria passing the GO test above) <= 6      # criteria need wording rules
NO-GO  if median(κ across the 10 criteria) < 0.4
NO-GO  if Jev answer_correct accuracy < 0.9 against the golden reference answers
       # added for the haystack-hypothesis corpus
```

Applied by `spike/report.ts` and printed verbatim as `Decision: GO`, `Decision: AMEND` or
`Decision: NO-GO` in `spike/REPORT.md`.
Verify: `grep -E '^Decision: (GO|AMEND|NO-GO)' spike/REPORT.md`.

## Call budget

≤ 50×3 = 150 judge calls (cached on disk keyed by content hash, so re-runs make 0 network calls);
≤ 60 generator calls.
Verify: `spike/data/cache/` file count ≤ 150 and a second `bun spike/judge.ts` run logs
`cache hits: 150, network: 0`.
Pre-spike precedent: caching by content hash deduplicated 1,368 calls to 1,038; `judge-jev` needs
request pacing + `Retry-After` backoff (2 workers sustained ~25 calls/min against gateway 429
bursts).

## Script constraints

Every script under `spike/` is plain Bun TypeScript, no framework, using only root
devDependencies; shared helpers live in `spike/lib/`. Each reads `AI_GATEWAY_API_KEY` from the
environment (loaded from `.env` via `bun --env-file=.env`), never prints the key or any request
body, and writes only under `spike/data/`. The judge script is the reference for J1's request
builder only as prose in `REPORT.md`, never as imported code (Approach).
Verify: `grep -rn 'AI_GATEWAY_API_KEY' spike/*.ts | grep -v 'process.env'` is empty and
`bun x vitest run --project spike` exit 0.

## Verification sequence

```
bun --env-file=.env spike/corpus.ts \
  && bun --env-file=.env spike/propose.ts \
  && bun --env-file=.env spike/judge.ts \
  && bun spike/label.ts \
  && bun spike/report.ts
bun x vitest run --project spike        # exit 0
grep -E '^Decision:' spike/REPORT.md    # prints one of GO / AMEND / NO-GO
```

## Out of scope

`packages/*` code (the spike is throwaway); real production traces (none exist); more
than one labeller.

## Limitations to state in REPORT.md

- Synthetic/near-ceiling corpus (the pre-spike run found almost no wrong answers): may be easier to
  judge than real traffic — the go/no-go verdict is about the METHOD, not the product.
- Contexts are rebuilt from whole source documents, not the 120-word chunks the pipeline actually
  judged — stated as a limitation, not corrected.
- With one labeller, Krippendorff α degenerates to κ against the judge.

## References

- https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe
- https://vercel.com/docs/ai-gateway/openai-compat
