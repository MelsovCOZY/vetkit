#!/usr/bin/env bash
# J5 slice-gate smoke (bd classified-evals-mol-pe8): OTel-in end-to-end, exactly the root
# acceptance J5 verify commands, against IN-PROCESS FAKE generator/judge adapters (the fake
# config from fixtures/cli/init/vetkit.config.ts, copied into a scratch project dir since
# `vet init` has no --config flag). No network, no keys: generation quality and judge calls
# are out of scope (bead Scope: OUT).
#
# Sequence: build -> five-dialect golden diff -> tokens check -> incomplete-fixture exclusion
# counts -> live receiver (ephemeral port, JSON POST, protobuf POST). Every step runs the AC's
# own verify command as literally written; a step that cannot pass as written is reported FAIL
# with repro/expected/actual, never silently adapted to pass. Do not fix product code from here.
#
# Usage: bash scripts/smoke-j5.sh
set -u

ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
BIN="$ROOT/packages/cli/dist/bin.js"
PROJECT="${VETKIT_SMOKE_DIR:-${TMPDIR:-/tmp}/vetkit-smoke-j5}"
OUT="$PROJECT/out"
FAILED=0

say() { printf 'smoke-j5: %s\n' "$*"; }
result() { # <label> <expected-exit> <observed-exit> <ok 0|1> [detail]
  local status=PASS
  if [ "$4" -ne 0 ]; then status=FAIL; FAILED=1; fi
  say "$status $1 (exit $3, expected $2)${5:+ — $5}"
}

say "building"
(
  cd "$ROOT" || exit 1
  if [ ! -d node_modules ]; then bun install --frozen-lockfile >/dev/null || exit 1; fi
  bun run build >/dev/null
) || { say "build failed" >&2; exit 1; }

rm -rf "$PROJECT"
mkdir -p "$OUT"
cp "$ROOT/fixtures/cli/init/vetkit.config.ts" "$PROJECT/vetkit.config.ts"
cd "$PROJECT" || exit 1
vet() { bun "$BIN" "$@"; }

# ---- AC1: five dialects -> identical normalized cases (ids aside) --------------------------
# Gate DECISION (c): diff against fixtures/otlp/golden/init-cases.jsonl (vet-init Case shape,
# bug pij.15), not golden/cases.jsonl (pij.9's unrelated normalized-trace golden). Normalization
# matches packages/cli/src/commands/init-otlp.test.ts's normalizeCase(): strip .id, .traceId and
# .provenance.traceIds (leaving any other provenance keys untouched).
DIALECTS="gen_ai-latest gen_ai-legacy openinference openllmetry vercel"
NORMALIZE='del(.id, .traceId, .provenance.traceIds)'
GOLDEN_CASES="$ROOT/fixtures/otlp/golden/init-cases.jsonl"
ac1_failed=0
for d in $DIALECTS; do
  rm -rf "$OUT/$d"
  vet init --source "otlp:$ROOT/fixtures/otlp/$d.json" --json --out "$OUT/$d" >"$OUT/$d.stdout.json" 2>"$OUT/$d.stderr.txt"
  code=$?
  diff <(jq -S "$NORMALIZE" "$OUT/$d/cases/generated.jsonl" 2>/dev/null) <(jq -S "$NORMALIZE" "$GOLDEN_CASES") >"$OUT/$d.diff.txt" 2>&1
  dcode=$?
  if [ "$code" -ne 0 ] || [ "$dcode" -ne 0 ]; then ac1_failed=1; fi
done
result "AC1: 5-dialect golden diff (for d in $DIALECTS; do vet init --source otlp:fixtures/otlp/\$d.json --json --out ...; diff <(jq -S '$NORMALIZE' out/cases/generated.jsonl) golden/init-cases.jsonl; done)" \
  0 0 "$ac1_failed" \
  "gen_ai-latest diff: $(wc -l <"$OUT/gen_ai-latest.diff.txt") lines non-empty (see $OUT/<dialect>.diff.txt per dialect)"

# ---- AC2: tokens are not double-counted ----------------------------------------------------
# <out>/summary.json is the top-level {cases,excluded,dialects,tokens} document (buildOtlpSummary,
# init-otlp.ts) — not nested under a "summary" key.
actual_tokens=$(jq '.tokens' "$OUT/gen_ai-latest/summary.json" 2>/dev/null)
golden_total=$(jq '.total' "$ROOT/fixtures/otlp/golden/tokens.json")
tokens_ok=1
[ "$actual_tokens" = "$golden_total" ] && tokens_ok=0
result "AC2: jq '.tokens' <out>/summary.json == golden tokens.json total" 0 0 "$tokens_ok" \
  "<out>/summary.json .tokens=$actual_tokens, golden fixtures/otlp/golden/tokens.json .total=$golden_total"

# ---- AC3: incomplete.json exclusion typing --------------------------------------------------
# Gate DECISION (a): --out is required by vet init --source; excluded is read from
# <out>/summary.json (top-level .excluded, same document as AC2).
INCOMPLETE_OUT="$OUT/incomplete"
rm -rf "$INCOMPLETE_OUT"
vet init --source "otlp:$ROOT/fixtures/otlp/incomplete.json" --json --out "$INCOMPLETE_OUT" >"$OUT/incomplete.stdout.json" 2>"$OUT/incomplete.stderr.txt"
incomplete_code=$?
excluded_actual=$(jq -c '.excluded' "$INCOMPLETE_OUT/summary.json" 2>/dev/null)
ac3_ok=1
if [ "$incomplete_code" -eq 0 ] && jq -e --argjson expected '{"content_not_captured":1,"truncated":2,"incomplete_trace":1}' \
  '.excluded == $expected' "$INCOMPLETE_OUT/summary.json" >/dev/null 2>&1; then
  ac3_ok=0
fi
result "AC3: vet init --source otlp:fixtures/otlp/incomplete.json --out <dir> --json; jq '.excluded' <out>/summary.json == {content_not_captured:1,truncated:2,incomplete_trace:1}" \
  0 0 "$ac3_ok" \
  "exit=$incomplete_code, <out>/summary.json .excluded=$excluded_actual"

# ---- AC4: receiver — ephemeral port, protobuf POST 415, JSON POST ok -----------------------
# Gate DECISION (b): the protobuf probe is posted BEFORE the JSON trace, since --until 1 closes
# the receiver as soon as that JSON trace is accepted; the listening port is read from stderr
# (the "listening" line — getLogger().info is stderr-only), not stdout.
RECV_OUT="$OUT/receiver"
rm -rf "$RECV_OUT"; mkdir -p "$RECV_OUT"
vet init --source "otlp::0" --until 1 --json --out "$RECV_OUT" >"$OUT/receiver.stdout.txt" 2>"$OUT/receiver.stderr.txt" &
recv_pid=$!
port=""
for _ in $(seq 1 50); do
  port=$(grep -oE '"listening":\{"port":[0-9]+\}' "$OUT/receiver.stderr.txt" 2>/dev/null | head -1 | grep -oE '[0-9]+')
  [ -n "$port" ] && break
  sleep 0.1
done
proto_http_code=$(curl -s -o "$OUT/recv_proto.out" -w '%{http_code}' -X POST "localhost:$port/v1/traces" -H 'content-type: application/x-protobuf' --data-binary @"$ROOT/fixtures/otlp/gen_ai-latest.json" 2>"$OUT/recv_proto.err")
proto_curl_exit=$?
curl -sf -X POST "localhost:$port/v1/traces" -H 'content-type: application/json' --data @"$ROOT/fixtures/otlp/gen_ai-latest.json" >"$OUT/recv_json.out" 2>&1
json_curl_exit=$?
wait "$recv_pid" 2>/dev/null
ac4_ok=1
{ [ "$json_curl_exit" -eq 0 ] && [ "$proto_http_code" = "415" ]; } && ac4_ok=0
result "AC4: otlp::0 receiver (port from stderr); protobuf POST -> HTTP 415 (probed before the JSON trace, per gate DECISION); curl JSON POST -> exit 0, closes on --until 1" 0 0 "$ac4_ok" \
  "port=$port; protobuf http_code=$proto_http_code curl_exit=$proto_curl_exit; JSON curl exit=$json_curl_exit"

if [ "$FAILED" -ne 0 ]; then
  say "FAILED"
  exit 1
fi
say "ok"
