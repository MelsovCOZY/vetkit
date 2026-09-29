#!/usr/bin/env bash
# J1 slice-gate smoke: judge one case with `vet run` against the
# REAL Jev judge through the vercel preset, and check every acceptance-criterion verify command.
#
# Sequence: build the workspace -> write a scratch project (one boolean criterion with an
# escape, one refund case, vetkit.config.ts on preset vercel) -> run each AC step and print
# its exit code -> exit 0 only when every step passed.
#
# Live calls: two judge requests per invocation (the passing case, the flipped case); every
# other step is a cache hit or refuses before any request. The project directory is wiped at
# the start, so reruns behave the same (idempotent) and step 1 always reaches the judge.
#
# Key: AI_GATEWAY_API_KEY from the environment, else from VETKIT_ENV_FILE (default: the repo
# .env) via `bun --env-file`. The key is never printed, and neither are judge bodies.
#
# Usage: bash scripts/smoke-j1.sh
set -u

ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
PROJECT="${VETKIT_SMOKE_DIR:-${TMPDIR:-/tmp}/vetkit-smoke-j1}"
ENV_FILE="${VETKIT_ENV_FILE:-$ROOT/.env}"
BIN="$ROOT/packages/cli/dist/bin.js"
FAILED=0

say() { printf 'smoke-j1: %s\n' "$*"; }
result() { # <label> <expected> <observed-exit> <ok 0|1> [detail]
  local status=PASS
  if [ "$4" -ne 0 ]; then status=FAIL; FAILED=1; fi
  say "$status $1 (exit $3, expected $2)${5:+ — $5}"
}

ENV_ARGS=()
if [ -z "${AI_GATEWAY_API_KEY:-}" ]; then
  if [ ! -f "$ENV_FILE" ]; then
    say "AI_GATEWAY_API_KEY is unset and $ENV_FILE does not exist" >&2
    exit 1
  fi
  ENV_ARGS=("--env-file=$ENV_FILE")
fi
vet() { bun "${ENV_ARGS[@]}" "$BIN" "$@"; }

say "building"
(
  cd "$ROOT" || exit 1
  if [ ! -d node_modules ]; then bun install --frozen-lockfile >/dev/null || exit 1; fi
  bun run build >/dev/null
) || { say "build failed" >&2; exit 1; }

rm -rf "$PROJECT"
mkdir -p "$PROJECT/evals/cases"
cd "$PROJECT" || exit 1
say "project $PROJECT"

cat >vetkit.config.ts <<'EOF'
export default {
  judge: {
    kind: 'typesafe-compatible',
    preset: 'vercel',
    apiKeyEnv: 'AI_GATEWAY_API_KEY',
    providerOptions: { gateway: { zeroDataRetention: true, only: ['typesafe-ai'] } },
  },
  thresholds: { default: 0.5, perCriterion: {} },
};
EOF

cat >evals/criteria.yaml <<'EOF'
criteria:
  - id: promised_refund
    type: boolean
    instructions: Did the assistant promise or issue a refund? Answer unclear if the transcript does not say.
    escape: unclear
    polarity: pass_when_true
    channel: outcome
    provenance:
      traceIds: []
EOF

# The refund transcript from docs/research/fixtures/2026-09-25-gateway-systemone-request.json.
PASS_CASE="$(jq -c '{id: "one", input: {state: .state}, provenance: null, tags: []}' \
  "$ROOT/docs/research/fixtures/2026-09-25-gateway-systemone-request.json")"
FAIL_CASE='{"id":"one","input":{"state":"User: Can I get a refund for my order #4411?\nAssistant: No. Order #4411 is outside the return window, so I cannot issue or promise any refund."},"provenance":null,"tags":[]}'
printf '%s\n' "$PASS_CASE" >evals/cases/one.jsonl

# Edge: missing key -> exit 2, CONFIG_INVALID naming the env var (no request, no key printed).
env -u AI_GATEWAY_API_KEY bun "$BIN" run --json >out0.json 2>err0.txt
code=$?
result "missing key: vet run --json" 2 "$code" "$([ "$code" -eq 2 ] && grep -q AI_GATEWAY_API_KEY err0.txt out0.json && echo 0 || echo 1)" "names AI_GATEWAY_API_KEY"

# AC1: verdict JSON with a resolved model, pinned recorded, status ok.
vet run --json >out1.json 2>err1.txt
code=$?
jq -e '.results[0].model.resolved != "" and (.results[0].model.pinned|type)=="boolean" and .results[0].status=="ok"' out1.json >/dev/null
ok=$?
result "AC1: vet run --json | jq -e '<resolved, pinned, status>'" 0 "$code" "$ok" \
  "$(jq -c '.results[0] | {resolved: .model.resolved, requested: .model.requested, transport: .model.transport, pinned: .model.pinned, status, cause, pass, probability: .answer.probability, answerKeys: ((.answer // {}) | keys), cacheHit}' out1.json 2>/dev/null)"
# An unscored verdict is not cached, so every later step would reach the judge again: stop
# here rather than spend more live calls on a judge that is not answering.
if [ "$FAILED" -ne 0 ]; then
  say "FAILED (AC1 did not score; later steps skipped to spend no more judge calls)"
  exit 1
fi

# AC2: an identical second run under CEV_DIAG=1 is a cache hit and the diag channel reports
# judge.requests == 0.
CEV_DIAG=1 vet run --json >out2.json 2>err2.txt
code=$?
jq -e '.results[0].cacheHit == true and .results[0].status == "ok"' out2.json >/dev/null
hit=$?
result "AC2a: CEV_DIAG=1 vet run --json -> .results[0].cacheHit == true" 0 "$code" "$hit" \
  "cacheHit=$(jq -c '.results[0].cacheHit' out2.json 2>/dev/null)"
# The diag channel is one JSON line on stderr: {"diag":{"judge":{"requests":N}}}.
grep '^{"diag"' err2.txt | jq -e -s 'length == 1 and .[0].diag.judge.requests == 0' >/dev/null
diag=$?
result "AC2b: CEV_DIAG=1 diag channel reports judge.requests == 0" 0 "$code" "$diag" \
  "$(grep '^{"diag"' err2.txt | head -1)"
# Supplementary zero-network check: with a bogus key any real request would fail with 401,
# so an ok cached verdict proves the second run did not reach the judge.
AI_GATEWAY_API_KEY=vetkit-smoke-invalid-key bun "$BIN" run --json >out2b.json 2>/dev/null
code=$?
jq -e '.results[0].cacheHit == true and .results[0].status == "ok"' out2b.json >/dev/null
result "AC2c: rerun with a bogus key is still ok from cache (no network)" 0 "$code" "$?"

# AC3: the flipped case fails the threshold -> exit 1; the passing case -> exit 0.
printf '%s\n' "$FAIL_CASE" >evals/cases/one.jsonl
vet run >out3.txt 2>err3.txt
code=$?
# Exit 1 must come from a scored fail, not an unscored verdict (which also exits 1).
result "AC3a: vet run (flipped case); echo \$?" 1 "$code" "$([ "$code" -eq 1 ] && grep -q '^fail one' out3.txt && echo 0 || echo 1)" "$(head -1 out3.txt)"
printf '%s\n' "$PASS_CASE" >evals/cases/one.jsonl
vet run >out3b.txt 2>err3b.txt
code=$?
result "AC3b: vet run (passing case); echo \$?" 0 "$code" "$([ "$code" -eq 0 ] && grep -q '^pass one' out3b.txt && echo 0 || echo 1)" "$(head -1 out3b.txt)"

# AC4: --gate without a lock -> exit 2 and stderr names criteria.lock.json.
vet run --gate >out4.txt 2>err4.txt
code=$?
result "AC4a: vet run --gate; echo \$?" 2 "$code" "$([ "$code" -eq 2 ] && echo 0 || echo 1)"
grep -q 'criteria.lock.json' err4.txt
result "AC4b: vet run --gate stderr names criteria.lock.json" 2 "$code" "$?" \
  "stderr: $(grep 'gate' err4.txt | head -1)"

if [ "$FAILED" -ne 0 ]; then
  say "FAILED"
  exit 1
fi
say "ok"
