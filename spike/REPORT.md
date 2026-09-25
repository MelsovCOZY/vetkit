# Spike report: Jev vs ground truth, Jev vs the Gemini judge (mol-vv7.5)

## (a) Per-criterion table (human/auto labels as truth)

| c | n | κ | α | threshold | TPR | TNR | flip% | escape% | verdict |
|---|---|---|---|---|---|---|---|---|---|
| c1 | 456 | 1.000 | 1.000 | 0.373 | 1.000 | 1.000 | 0.7% | 5.3% | pass |
| c2 | 456 | 0.000 | -0.024 | 0.000 | 1.000 | 0.000 | 0.0% | 0.0% | fail |
| c3 | 456 | n/a | n/a | n/a | n/a | n/a | 0.0% | 0.0% | pending |
| c4 | 456 | n/a | n/a | n/a | n/a | n/a | 0.0% | 0.0% | pending |
| c5 | 456 | n/a | n/a | n/a | n/a | n/a | 0.0% | 0.0% | pending |
| c6 | 456 | n/a | n/a | n/a | n/a | n/a | 0.0% | 0.0% | pending |
| c7 | 456 | n/a | n/a | n/a | n/a | n/a | 0.0% | 0.0% | pending |
| c8 | 456 | n/a | n/a | n/a | n/a | n/a | 0.0% | 0.0% | pending |
| c9 | 456 | n/a | n/a | n/a | n/a | n/a | 0.0% | 0.0% | pending |
| c10 | 456 | n/a | n/a | n/a | n/a | n/a | 0.0% | 0.0% | pending |

c3's truth is the Gemini baseline, not a human/auto label, so it has no row-fitted stats here and is reported separately in block (c); c4-c10 have no truth yet (pending classified-evals-mol-vv7.7). c2's auto label is a *correctness* judgment (abstained-when-it-should, or didn't-when-it-shouldn't), which flips sign between answerable and unanswerable rows, so its raw P(yes)-vs-label kappa above is not directly comparable to c1's; see block (b) for the c2 accuracy computed only on the unambiguous (golden-unanswerable) subset.

## (b) Ground-truth block

### c1 answer_correct vs the reference-derived labels

| slice | n | accuracy | TPR | TNR |
|---|---|---|---|---|
| all | 432 | 1.000 | 1.000 | 1.000 |
| variant:bm25 | 108 | 1.000 | 1.000 | n/a |
| variant:embedding | 108 | 1.000 | 1.000 | n/a |
| variant:hybrid | 108 | 1.000 | 1.000 | n/a |
| variant:hybrid-norerank | 108 | 1.000 | 1.000 | 1.000 |

### c2 abstains_when_unanswerable on the golden-unanswerable rows

| slice | n | accuracy | TPR | TNR |
|---|---|---|---|---|
| unanswerable | 24 | 0.792 | 1.000 | 0.000 |

## (c) Baseline block (Jev c3 vs the Gemini judge, binarised at 0.5)

| slice | n | κ |
|---|---|---|
| all | 456 | 0.119 |
| lang:en | 152 | 0.000 |
| lang:ru | 152 | 0.000 |
| lang:kk | 152 | 0.198 |

## (d) Cost

Jev: 2993298 input tokens over 1038 unique cached calls (1368 logical calls: 456 traces x 3 repeats; 4151715 input tokens if every logical call were billed separately, but only the unique calls were actually sent to the gateway) ~= $0.1257 at $0.042/M input.

Gemini plain-mode judge (from the four ~/Projects/haystack-hypothesis/report/eval-*.json cost blocks): 2724003 judge_prompt_tokens + 118009 judge_completion_tokens = 2842012 tokens.

The c4-c10 generator was openai/gpt-5-mini (free-tier gateway, 4 calls); its usage was not recorded by spike/lib, so generator cost is not available.

## (e) Limitations

Contexts are whole source documents (55-344 words) rebuilt offline from corpus/*.pdf|docx, not the 120-word chunks the pipeline actually retrieved by; the local Langfuse instance runs in v4 events-only mode and /api/public/traces returned 404 (probed 2026-09-25), so the judged unit is whole-document context, not the retrieved chunk.

Human labels: this run has 0 human-labelled rows (labelled traces filed as classified-evals-mol-vv7.7, still pending). With a single labeller once that lands, Krippendorff alpha reduces to plain agreement between the human and the judge; a second labeller is out of scope of this spike.

Jev is reached only through the gateway alias typesafe-ai/jev (TypeSafe registration is closed); the served model id recorded on every verdict is that alias, release_date 2026-09-15 per docs/research/fixtures/2026-09-25-gateway-models.json; `pinned: false`.

The Gemini baseline is near ceiling: per-variant aggregate faithfulness across the four haystack-hypothesis runs is 0.991, 0.991, 0.982, 0.991 (bm25/embedding/hybrid/hybrid-norerank) - the baseline comparison (block c) shows Jev reads references and abstentions reliably where the baseline rarely scores unfaithful, not that it catches subtle hallucinations.

Decision: INCONCLUSIVE
