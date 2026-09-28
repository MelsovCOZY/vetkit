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
DIALECTS="gen_ai-latest gen_ai-legacy openinference openllmetry vercel"
ac1_failed=0
for d in $DIALECTS; do
  rm -rf "$OUT/$d"
  vet init --source "otlp:$ROOT/fixtures/otlp/$d.json" --json --out "$OUT/$d" >"$OUT/$d.stdout.json" 2>"$OUT/$d.stderr.txt"
  code=$?
  diff <(jq -S 'del(.provenance.traceId)' "$OUT/$d"/cases/*.jsonl 2>/dev/null) "$ROOT/fixtures/otlp/golden/cases.jsonl" >"$OUT/$d.diff.txt" 2>&1
  dcode=$?
  if [ "$code" -ne 0 ] || [ "$dcode" -ne 0 ]; then ac1_failed=1; fi
done
result "AC1: 5-dialect golden diff (for d in $DIALECTS; do vet init --source otlp:fixtures/otlp/\$d.json --json --out ...; diff <(jq -S 'del(.provenance.traceId)' out/cases/*.jsonl) golden/cases.jsonl; done)" \
  0 0 "$ac1_failed" \
  "gen_ai-latest diff: $(wc -l <"$OUT/gen_ai-latest.diff.txt") lines non-empty; generated case shape is {id,input,traceId,provenance:{traceIds}} (core/src/generate/cases.ts:92-98), golden/cases.jsonl shape is {file,messages,spans} (authored for packages/source-otlp/src/golden.test.ts, a different comparison) — the two were never the same shape, ids aside or not"

# ---- AC2: tokens are not double-counted ----------------------------------------------------
jq '.tokens' "$OUT/gen_ai-latest.stdout.json" >"$OUT/tokens_literal.txt" 2>&1
literal_tokens=$(cat "$OUT/tokens_literal.txt")
actual_tokens=$(jq '.summary.tokens' "$OUT/gen_ai-latest.stdout.json" 2>/dev/null)
golden_total=$(jq '.total' "$ROOT/fixtures/otlp/golden/tokens.json")
tokens_ok=1
[ "$literal_tokens" = "$golden_total" ] && tokens_ok=0
result "AC2: jq '.tokens' <out>/summary.json == golden tokens.json total" 0 0 "$tokens_ok" \
  "literal '.tokens' -> $literal_tokens (no such top-level field, and vet init writes no summary.json file — emit() is stdout-only, packages/cli/src/output.ts:84); actual value lives at .summary.tokens -> $actual_tokens, golden total -> $golden_total ($([ "$actual_tokens" = "$golden_total" ] && echo 'matches' || echo 'MISMATCH'))"

# ---- AC3: incomplete.json exclusion typing --------------------------------------------------
vet init --source "otlp:$ROOT/fixtures/otlp/incomplete.json" --json >"$OUT/incomplete_literal.json" 2>"$OUT/incomplete_literal.err"
literal_code=$?
vet init --source "otlp:$ROOT/fixtures/otlp/incomplete.json" --json --out "$OUT/incomplete" >"$OUT/incomplete.json" 2>"$OUT/incomplete.err"
adapted_code=$?
excluded_actual=$(jq -c '.summary.excluded' "$OUT/incomplete.json" 2>/dev/null)
expected='{"content_not_captured":1,"truncated":2,"incomplete_trace":1}'
ac3_ok=1
[ "$excluded_actual" = "$expected" ] && ac3_ok=0
result "AC3: vet init --source otlp:fixtures/otlp/incomplete.json --json | jq '.excluded' == {content_not_captured:1,truncated:2,incomplete_trace:1}" \
  0 0 "$ac3_ok" \
  "literal command (no --out) exits $literal_code CONFIG_INVALID '--source requires --out <dir>' (init.ts requires --out); with --out added, .excluded is null (field is .summary.excluded, init-otlp.ts:170), actual .summary.excluded=$excluded_actual — extractCases (core/src/generate/cases.ts:70-101) never calls statusForTrace/partitionCases (core/src/judge/completeness.ts:18-27), so 'truncated' and 'incomplete_trace' are never produced by vet init at all"

# ---- AC4: receiver — ephemeral port, JSON POST ok, protobuf POST 415 -----------------------
RECV_OUT="$OUT/receiver"
rm -rf "$RECV_OUT"; mkdir -p "$RECV_OUT"
vet init --source "otlp::0" --until 1 --json --out "$RECV_OUT" >"$OUT/receiver.stdout.txt" 2>"$OUT/receiver.stderr.txt" &
recv_pid=$!
port=""
for _ in $(seq 1 50); do
  port=$(grep -oE '"port":[0-9]+' "$OUT/receiver.stderr.txt" 2>/dev/null | head -1 | grep -oE '[0-9]+')
  [ -n "$port" ] && break
  sleep 0.1
done
listen_line_stream=$(grep -q listening "$OUT/receiver.stdout.txt" 2>/dev/null && echo stdout || echo stderr)
curl -sf -X POST "localhost:$port/v1/traces" -H 'content-type: application/json' --data @"$ROOT/fixtures/otlp/gen_ai-latest.json" >"$OUT/recv_json.out" 2>&1
json_curl_exit=$?
proto_http_code=$(curl -s -o "$OUT/recv_proto.out" -w '%{http_code}' -X POST "localhost:$port/v1/traces" -H 'content-type: application/x-protobuf' --data-binary @"$ROOT/fixtures/otlp/gen_ai-latest.json" 2>>"$OUT/recv_proto.err")
proto_curl_exit=$?
wait "$recv_pid" 2>/dev/null
ac4_ok=1
{ [ "$json_curl_exit" -eq 0 ] && [ "$proto_http_code" = "415" ]; } && ac4_ok=0
result "AC4: otlp::0 receiver; curl JSON POST exit 0; curl protobuf POST -> HTTP 415" 0 0 "$ac4_ok" \
  "listening line is on $listen_line_stream, not stdout as the bead's edge-case note assumes (getLogger().info is stderr-only, output.ts:84); port=$port; JSON curl exit=$json_curl_exit; protobuf curl (run AFTER the JSON POST, per AC order) http_code=$proto_http_code curl_exit=$proto_curl_exit ($([ "$proto_curl_exit" -eq 7 ] && echo 'connection refused: receiver already closed after --until 1 was satisfied by the JSON POST, init-otlp.ts:103-104,115-117' || echo 'n/a'))"

if [ "$FAILED" -ne 0 ]; then
  say "FAILED"
  exit 1
fi
say "ok"
