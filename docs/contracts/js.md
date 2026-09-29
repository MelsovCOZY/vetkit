# Contract: JS — spike testing whether generated criteria agree with human labels

Status: reference document for the JS spike, enforced by the `spike/` scripts and tests listed in
"Enforced by" below. It records the acceptance criteria, design decisions, names, shapes, versions
and script names; the spike protocol itself is `spike/PROTOCOL.md`.

## Why

The founding hypothesis — atomic typed criteria written by a generator LLM and judged by Jev agree
with humans well enough to gate CI — is untested. The spike answers it with a week of work before
the IR, core and adapters are built.

## Acceptance criteria (AC-1..AC-6)

- **AC-1 (protocol doc + gate).** The spike protocol is written down before any script runs:
  `spike/PROTOCOL.md` states the corpus (haystack-hypothesis, see AC-6), the criteria set
  (10 boolean criteria with an explicit escape/unknown option), the judge (Jev via the TypeSafe-compatible gateway endpoint, model `typesafe-ai/jev`, N=3 repeats per
  trace×criterion), the human labels (≥30 traces × 10 criteria, one labeller), the metrics (Cohen κ
  and Krippendorff α per criterion at the fitted threshold, TPR/TNR, flip rate across the 3
  repeats), and the go/no-go rule.
  Verify: `test -s spike/PROTOCOL.md` and the JS gate reads the rule from it.
- **AC-2 (go/no-go rule, the spike's deliverable).** GO if ≥7 of 10 criteria reach κ ≥ 0.6 with
  TPR ≥ 0.8 and TNR ≥ 0.8 on the labelled set and the boolean flip rate at threshold is ≤ 5%;
  AMEND (criteria need wording rules) if 4–6 criteria pass; NO-GO if median κ < 0.4 — applied by
  `spike/report.ts` and printed verbatim in `spike/REPORT.md`.
  Verify: `grep -E '^Decision: (GO|AMEND|NO-GO)' spike/REPORT.md`.
- **AC-3 (script constraints).** Every spike script is a Bun script under `spike/` using only root
  devDependencies, reads `AI_GATEWAY_API_KEY` from the environment (loaded from `.env` by
  `bun --env-file=.env`), never prints the key or any request body, and writes only under
  `spike/data/`.
  Verify: `grep -rn 'AI_GATEWAY_API_KEY' spike/*.ts | grep -v 'process.env'` is empty and
  `bun x vitest run --project spike` exit 0.
- **AC-4 (wire shapes, verified by probe).** Judge requests
  `POST https://ai-gateway.vercel.sh/typesafe/v1/systemone` with
  `{model:'typesafe-ai/jev', state, questions:{<id>:{type:'noul', instructions}}, providerOptions:{gateway:{only:['typesafe-ai'], zeroDataRetention:true}}}`
  and read `answers.<id>.noul`; generator requests
  `POST https://ai-gateway.vercel.sh/v1/chat/completions` (OpenAI-compatible) with
  `response_format: {type:'json_schema'}`.
  Verify: `spike/judge.test.ts` and `spike/corpus.test.ts` assert the request bodies against the
  shape of `docs/research/fixtures/2026-09-25-gateway-systemone-request.json`.
- **AC-5 (call budget).** One judge request per trace per repeat carrying all 10 criteria
  (≤ 50×3 = 150 judge calls, cached on disk so re-runs make 0 network calls), ≤ 60 generator calls.
  Verify: `spike/data/cache/` file count ≤ 150 and a second `bun spike/judge.ts` run logs
  `cache hits: 150, network: 0`.
- **AC-6 (corpus contract).** The spike corpus is haystack-hypothesis (AC-1's "≥50 synthetic"
  corpus is replaced by it). `traces.jsonl` rows carry `question, answer, contexts[{docId,text}],
  reference, unanswerable, lang, variant, baseline{faithfulness, context_relevance, judgeModel}`;
  c1–c3 are fixed ground-truth criteria; the report's Decision rule adds NO-GO when Jev
  `answer_correct` accuracy < 0.9 against the golden references.
  Verify: `jq -e '.[0] | has("reference") and has("baseline")' <(head -1 spike/data/traces.jsonl | jq -s .)`
  and `grep -c 'accuracy' spike/REPORT.md` ≥ 1.

## Design decisions

- Spike first: a one-week throwaway spike (JS) that tests whether generated criteria agree with
  human labels, then the criteria compiler with exporters.
- JSONL trace export is the trace source for the spike and the first runnable journey (J1/J2); OTel
  is the first real adapter after that.
- The generator is model-agnostic and provider-agnostic — a `GeneratorV1` adapter interface; the
  spike uses the gateway's OpenAI-compatible `/v1/chat/completions` with a model id from
  `SPIKE_GENERATOR_MODEL` (default `anthropic/claude-sonnet-5`), never hard-coded in a library.
- `AI_GATEWAY_API_KEY` lives in `./.env` (`.env` is gitignored, `.env.example` lists accepted
  variable names). The judge adapter is
  `judge: { kind: 'typesafe-compatible', baseURL, apiKeyEnv, model, providerOptions? }`.
- The spike corpus is the haystack-hypothesis evals, run in plain mode and compared with Jev; the
  spike does not synthesise traces. See `spike/PROTOCOL.md` for the full corpus description.
- The judge hypothesis is confirmed on real data: Jev is a reliable, ~20× cheaper multilingual judge
  for reference-match, abstention and faithfulness questions. Consequences: (1) JS keeps its
  purpose (generated criteria vs human labels) but reuses the pre-spike judge and analysis scripts
  and the verdict cache for c1–c3 (`docs/research/fixtures/jev-haystack/{judge.py,analyze.py,cases.jsonl,verdicts.jsonl}`; done for the spike, tables already in the pre-spike report);
  (2) judge-jev must implement request pacing + Retry-After backoff and cache by content hash
  (dedup 1,368 → 1,038 calls in the pre-spike run); (3) the escape/3-way choice design is
  validated; (4) a lint rule for regex-based abstention scoring is a candidate generated criterion.
- Jev answers drift run to run (measured), hence N=3 repeats and flip rate as a metric.
- Jev does not abstain unless an escape option exists, so every criterion carries one.

## Scope

In scope: everything under `spike/` and the report. Out of scope: any `packages/*` code (the spike
is throwaway and must not be reused); real production traces (none exist); more than one labeller
(α with one rater degenerates to κ against the judge — documented).

## Approach

Scripts are plain Bun TypeScript with no framework; shared helpers in `spike/lib/`. The judge
script is the reference for J1's request builder only as prose in `REPORT.md`, never as imported
code. Closest example: Braintrust autoevals' `LLMClassifierFromTemplate` evaluation harness for the
label-vs-judge comparison table.

## Enforced by

| Criterion | Enforced by |
|---|---|
| AC-1 protocol doc exists | `spike/PROTOCOL.md` (`test -s spike/PROTOCOL.md`) |
| AC-1 "JS gate reads the rule from it" | `spike/report.ts` |
| AC-2 go/no-go rule, `Decision:` line | `spike/report.ts` / `spike/REPORT.md` |
| AC-3 script constraints (Bun-only, no key printing, `spike/data/` only) | Every `spike/*.ts` script; `spike/*.test.ts` under the `spike` vitest project |
| AC-4 wire shapes | `spike/judge.ts` + `spike/judge.test.ts`; `spike/corpus.ts` + `spike/corpus.test.ts` |
| AC-5 call budget / cache | `spike/judge.ts` (disk cache, `spike/data/cache/`) |
| AC-6 corpus contract (`traces.jsonl` shape, NO-GO accuracy rule) | `spike/corpus.ts` (builds `traces.jsonl`) + `spike/report.ts` (accuracy line in `REPORT.md`) |

## References

- https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe
- https://vercel.com/docs/ai-gateway/openai-compat
