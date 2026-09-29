# Spike report: Jev vs ground truth, Jev vs the Gemini judge

PROVISIONAL (model-labelled)

## (a) Per-criterion table (human > model > auto labels as truth)

| c | n | κ | α | threshold | TPR | TNR | flip% | escape% | verdict |
|---|---|---|---|---|---|---|---|---|---|
| c1 | 456 | 1.000 | 1.000 | 0.373 | 1.000 | 1.000 | 0.7% | 0.0% | pass |
| c2 | 456 | 0.000 | -0.024 | 0.000 | 1.000 | 0.000 | 0.0% | 0.0% | fail |
| c3 | 30 | n/a | n/a | 0.760 | 1.000 | n/a | 7.7% | 13.3% | not evaluable (single-class truth) |
| c4 | 30 | n/a | n/a | 0.743 | n/a | 0.962 | 7.7% | 13.3% | not evaluable (single-class truth) |
| c5 | 30 | n/a | n/a | 0.793 | 1.000 | n/a | 3.8% | 13.3% | not evaluable (single-class truth) |
| c6 | 30 | n/a | n/a | 0.503 | n/a | 0.933 | 6.7% | 50.0% | not evaluable (single-class truth) |
| c7 | 30 | n/a | n/a | 0.313 | n/a | 0.952 | 4.8% | 30.0% | not evaluable (single-class truth) |
| c8 | 30 | n/a | n/a | 0.100 | n/a | 0.944 | 5.6% | 40.0% | not evaluable (single-class truth) |
| c9 | 30 | n/a | n/a | 0.800 | n/a | 0.967 | 3.3% | 0.0% | not evaluable (single-class truth) |
| c10 | 30 | n/a | n/a | 0.180 | n/a | 0.800 | 20.0% | 83.3% | not evaluable (single-class truth) |

Truth is human > model > auto; n is the number of labelled traces per criterion. This run has 264 model-labelled rows over 51 traces and 0 human-labelled rows, so c3-c10 rows rest on model labels. For c4-c10 a yes label means the problem is present. Gemini baseline scores are not truth and are reported in block (c). c2's auto label is a *correctness* judgment (abstained-when-it-should, or didn't-when-it-shouldn't), which flips sign between answerable and unanswerable rows, so its raw P(yes)-vs-label kappa above is not directly comparable to c1's; see block (b) for the c2 accuracy computed only on the unambiguous (golden-unanswerable) subset.

## (b) Ground-truth block

### c1 answer_correct vs the reference-derived labels

| slice | n | accuracy | TPR | TNR |
|---|---|---|---|---|
| all | 456 | 1.000 | 1.000 | 1.000 |
| variant:bm25 | 114 | 1.000 | 1.000 | n/a |
| variant:embedding | 114 | 1.000 | 1.000 | n/a |
| variant:hybrid | 114 | 1.000 | 1.000 | n/a |
| variant:hybrid-norerank | 114 | 1.000 | 1.000 | 1.000 |

### c2 abstains_when_unanswerable on the golden-unanswerable rows

| slice | n | accuracy | TPR | TNR |
|---|---|---|---|---|
| unanswerable | 24 | 0.792 | 1.000 | 0.000 |

## (c) Baseline block (Jev c3 vs the Gemini judge, binarised at 0.5; plus vs model labels)

| slice | n | κ |
|---|---|---|
| all | 456 | 0.119 |
| lang:en | 152 | 0.000 |
| lang:ru | 152 | 0.000 |
| lang:kk | 152 | 0.198 |

Jev c3 vs the model-labelled c3 truth (thresholded at the c3 threshold fitted in table (a)):

| slice | n | κ |
|---|---|---|
| model labels | 26 | n/a |

## (d) Cost

Jev: 2993298 input tokens over 1038 unique cached calls (1368 logical calls: 456 traces x 3 repeats; 4151715 input tokens if every logical call were billed separately, but only the unique calls were actually sent to the gateway) ~= $0.1257 at $0.042/M input.

Gemini plain-mode judge (from the four ~/Projects/haystack-hypothesis/report/eval-*.json cost blocks): 2724003 judge_prompt_tokens + 118009 judge_completion_tokens = 2842012 tokens.

The c4-c10 generator was openai/gpt-5-mini (free-tier gateway, 4 calls); its usage was not recorded by spike/lib, so generator cost is not available.

## (e) Limitations

Contexts are whole source documents (55-344 words) rebuilt offline from corpus/*.pdf|docx, not the 120-word chunks the pipeline actually retrieved by; the local Langfuse instance runs in v4 events-only mode and /api/public/traces returned 404 (probed 2026-09-25), so the judged unit is whole-document context, not the retrieved chunk.

Labels: this run has 0 human-labelled traces (0 rows) and 51 model-labelled traces (264 rows); truth precedence is human, then model, then auto. Model labels stand in for a human labeller, so any decision drawn from them is provisional. With a single labeller, Krippendorff alpha reduces to plain agreement between the labeller and the judge; a second labeller is out of scope of this spike.

Not evaluable: c3, c4, c5, c6, c7, c8, c9, c10 - the labelled sample has no positive cases (or no negative cases) for them, so truth is single-class and kappa is undefined; they are excluded from the median-kappa rule and cannot count toward the pass count.

Jev is reached only through the gateway alias typesafe-ai/jev (TypeSafe registration is closed); the served model id recorded on every verdict is that alias, release_date 2026-09-15 per docs/research/fixtures/2026-09-25-gateway-models.json; `pinned: false`.

The Gemini baseline is near ceiling: per-variant aggregate faithfulness across the four haystack-hypothesis runs is 0.991, 0.991, 0.982, 0.991 (bm25/embedding/hybrid/hybrid-norerank) - the baseline comparison (block c) shows Jev reads references and abstentions reliably where the baseline rarely scores unfaithful, not that it catches subtle hallucinations.

## Decision rule

GO if ≥7 of 10 criteria reach κ ≥ 0.6 with TPR ≥ 0.8 and TNR ≥ 0.8 on the labelled set and the boolean flip rate at threshold is ≤ 5%; AMEND (criteria need wording rules) if 4–6 criteria pass; NO-GO if median κ < 0.4

Extended per this bead's acceptance criteria with a NO-GO override when c1 accuracy < 0.9.

Precedence: INCONCLUSIVE (fewer than 30 human-labelled traces or 300 total label rows) first; then c1 accuracy < 0.9 -> NO-GO; then median kappa < 0.4 -> NO-GO; then >=7 criteria passing -> GO; otherwise AMEND.

Decision: AMEND PROVISIONAL (model-labelled)
