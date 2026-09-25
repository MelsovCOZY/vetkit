# Contract: JS — spike testing whether generated criteria agree with human labels

Docs-only contract bead (bd `classified-evals-mol-xy5`). This is a reference doc: it records the
acceptance criteria, design decisions, names, shapes, versions and script names later beads build
against. It does not implement anything; the spike protocol itself is `spike/PROTOCOL.md` (same
bead, see below). Facts are copied verbatim from the bd payload and the root epic
`classified-evals-d4m` ledger; no fact is invented.

## Why (verbatim)

The founding premise — atomic typed criteria written by a generator LLM and judged by Jev agree
with humans well enough to gate CI — has never been tested by this team. The spike buys that
answer for a week of work before the IR, core and adapters are built (DECISION resolves OPEN-1).

## Acceptance criteria (verbatim, numbered AC-1..AC-6)

- **AC-1 (protocol doc + gate).** The spike protocol is written down before any script runs:
  `spike/PROTOCOL.md` states the corpus (≥50 synthetic customer-support traces — see Supersession
  below), the criteria set (10 boolean criteria with an explicit escape/unknown option), the judge
  (Jev via the TypeSafe-compatible gateway endpoint, model `typesafe-ai/jev`, N=3 repeats per
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
- **AC-4 (wire shapes, PREMISE VERIFIED probe 2026-09-25).** Judge requests
  `POST https://ai-gateway.vercel.sh/typesafe/v1/systemone` with
  `{model:'typesafe-ai/jev', state, questions:{<id>:{type:'noul', instructions}}, providerOptions:{gateway:{only:['typesafe-ai'], zeroDataRetention:true}}}`
  and read `answers.<id>.noul`; generator requests
  `POST https://ai-gateway.vercel.sh/v1/chat/completions` (OpenAI-compatible) with
  `response_format: {type:'json_schema'}`.
  Verify: `spike/judge.test.ts` and `spike/corpus.test.ts` assert the request bodies against
  `docs/research/fixtures/2026-09-25-gateway-systemone-request.json`'s shape.
- **AC-5 (call budget).** One judge request per trace per repeat carrying all 10 criteria
  (≤ 50×3 = 150 judge calls, cached on disk so re-runs make 0 network calls), ≤ 60 generator calls.
  Verify: `spike/data/cache/` file count ≤ 150 and a second `bun spike/judge.ts` run logs
  `cache hits: 150, network: 0`.
- **AC-6 (corpus contract, DECISION spike corpus = haystack-hypothesis, supersedes the "≥50
  synthetic" line in AC-1).** `traces.jsonl` rows carry `question, answer, contexts[{docId,text}],
  reference, unanswerable, lang, variant, baseline{faithfulness, context_relevance, judgeModel}`;
  c1–c3 are fixed ground-truth criteria; the report's Decision rule adds NO-GO when Jev
  `answer_correct` accuracy < 0.9 against the golden references.
  Verify: `jq -e '.[0] | has("reference") and has("baseline")' <(head -1 spike/data/traces.jsonl | jq -s .)`
  and `grep -c 'accuracy' spike/REPORT.md` ≥ 1.

## Design decisions cited (verbatim, from the root epic `classified-evals-d4m` ledger)

- DECISION (resolves OPEN-1, user 2026-09-25 "go with defaults"): spike first — a one-week
  throwaway slice (JS) that tests whether generated criteria agree with human labels — then the
  criteria compiler with exporters.
- DECISION (resolves OPEN-2, user 2026-09-25): JSONL trace export is the trace source for the
  spike and the first runnable journey (J1/J2); OTel is the first real adapter after that.
- DECISION (resolves OPEN-6, user 2026-09-25): the generator is model-agnostic and
  provider-agnostic — a `GeneratorV1` adapter interface; the spike uses the gateway's
  OpenAI-compatible `/v1/chat/completions` with a model id from `SPIKE_GENERATOR_MODEL` (default
  `anthropic/claude-sonnet-5`), never hard-coded in a library.
- DECISION (resolves OPEN-9, user 2026-09-25): `AI_GATEWAY_API_KEY` in `./.env`
  (`.env` is gitignored, `.env.example` lists accepted variable names). The judge adapter is
  `judge: { kind: 'typesafe-compatible', baseURL, apiKeyEnv, model, providerOptions? }`.
- DECISION (spike corpus = haystack-hypothesis, user 2026-09-25 "we have evals that we can just
  run in plain mode and compare with jev"): the JS spike no longer synthesises traces; see
  `spike/PROTOCOL.md` for the full corpus description and the AC-1 supersession note.
- DECISION (pre-spike outcome): the judge premise is confirmed on real data — Jev is a reliable,
  ~20× cheaper multilingual judge for reference-match, abstention and faithfulness questions.
  Consequences: (1) JS keeps its purpose (generated criteria vs human labels) but reuses
  `docs/research/fixtures/jev-haystack/{judge,analyze}.py` and the verdict cache for c1–c3 (DONE
  for the spike, tables already in the pre-spike report); (2) judge-jev must implement request
  pacing + Retry-After backoff and cache by content hash (dedup 1,368 → 1,038 calls in the
  pre-spike run); (3) the escape/3-way choice design is validated; (4) a lint rule for
  regex-based abstention scoring is a candidate generated criterion.
- DECISION (re-freeze 2026-09-25): plan_commit refreshed after the corpus switch and the J0
  hook-chain/graphify leaf; no other criteria changed.
- RISK (measured 2026-09-25): Jev answers drift run to run — hence N=3 repeats and flip rate as a
  metric.
- RISK (Jev judge behaviour): no abstention unless an escape option exists — every criterion
  carries one.

## Scope (verbatim)

IN: everything under `spike/` and the report. OUT: any `packages/*` code (the spike must not be
reused — DECISION resolves OPEN-1 says throwaway); real production traces (none exist); more than
one labeller (α with one rater degenerates to κ against the judge — documented).

## Approach (verbatim)

Scripts are plain Bun TypeScript with no framework; shared helpers in `spike/lib/`. The judge
script is the reference for J1's request builder only as prose in `REPORT.md`, never as imported
code. Closest example: Braintrust autoevals' `LLMClassifierFromTemplate` evaluation harness
(`docs/research/2026-09-25-jev-eval-generation-brief.md` §3) for the label-vs-judge comparison
table.

## Enforced by

| Criterion | Enforced by |
|---|---|
| AC-1 protocol doc exists | This bead: `spike/PROTOCOL.md` (`test -s spike/PROTOCOL.md`) |
| AC-1 "JS gate reads the rule from it" | Bead owning `spike/report.ts` |
| AC-2 go/no-go rule, `Decision:` line | Bead owning `spike/report.ts` / `spike/REPORT.md` |
| AC-3 script constraints (Bun-only, no key printing, `spike/data/` only) | Every bead owning a
  `spike/*.ts` script; `spike/*.test.ts` under the `spike` vitest project |
| AC-4 wire shapes | Bead owning `spike/judge.ts` + `spike/judge.test.ts`; bead owning
  `spike/corpus.ts` + `spike/corpus.test.ts` |
| AC-5 call budget / cache | Bead owning `spike/judge.ts` (disk cache, `spike/data/cache/`) |
| AC-6 corpus contract (`traces.jsonl` shape, NO-GO accuracy rule) | Bead owning `spike/corpus.ts`
  (js-1, builds `traces.jsonl`) + bead owning `spike/report.ts` (accuracy line in `REPORT.md`) |

## References (verbatim)

Root acceptance JS line; `docs/research/2026-09-25-jev-eval-generation-brief.md` §2.2 (escape
options, calibration), §4; `docs/research/2026-09-25-eval-types-programs-otel-brief.md` §2
(labelling, α, TPR/TNR); https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe ;
https://vercel.com/docs/ai-gateway/openai-compat ; `docs/research/fixtures/`.
