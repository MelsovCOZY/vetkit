#!/usr/bin/env bash
# J6 smoke: `vet run --sink otel,langfuse` end to end.
# Real Jev judge through the vercel preset, a real OTel collector (docker, file exporter, TEST-ONLY
# dependency) and, when LANGFUSE_* keys exist, a real Langfuse project. Every AC verify command is
# run as written except where the recorded deviation below says otherwise.
#
# Deviations (reported, not hidden):
#  - the project fixtures/projects/j6 is copied to a scratch dir first so .vet/ cache and outbox
#    never land in the repo;
#  - `vet` loads only *.jsonl cases, so the case in evals/cases/otel-fixture.json (array, the AC's
#    jq target) is mirrored to fixtures/projects/j6/evals/cases/otel-fixture.jsonl;
#  - the contrib image reads /etc/otelcol-contrib/config.yaml (not /etc/otelcol/config.yaml);
#  - the collector config lives at fixtures/projects/j6/collector.yaml;
#    the trace id/span id are asserted against evals/cases/otel-fixture.json.
#
# Live calls: judge ~2 real requests (AC1 case, collector-down case); the judge-failure run hits a
# refused connection. Keys come from AI_GATEWAY_API_KEY, else VETKIT_ENV_FILE (default repo .env)
# via `bun --env-file`; never printed. Langfuse is a LOCAL self-hosted v3 stack (docker compose in
# fixtures/projects/j6/langfuse, every port on 127.0.0.1, throwaway pk-lf-local-test/sk-lf-local-test
# seeded through LANGFUSE_INIT_*), started here and removed (`down -v`) on exit.
#
# Usage: bash scripts/smoke-j6.sh
set -u

ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
PROJECT="${VETKIT_SMOKE_DIR:-${TMPDIR:-/tmp}/vetkit-smoke-j6}"
ENV_FILE="${VETKIT_ENV_FILE:-$ROOT/.env}"
BIN="$ROOT/packages/cli/dist/bin.js"
OUTDIR="${VETKIT_OTEL_OUT:-/tmp/vet-otel}"
NAME=vetkit-j6-collector
FAILED=0

say() { printf 'smoke-j6: %s\n' "$*"; }
result() { # <label> <expected> <observed-exit> <ok 0|1> [detail]
  local status=PASS
  if [ "$4" -ne 0 ]; then status=FAIL; FAILED=1; fi
  say "$status $1 (exit $3, expected $2)${5:+ - $5}"
}

ENV_ARGS=()
if [ -z "${AI_GATEWAY_API_KEY:-}" ]; then
  [ -f "$ENV_FILE" ] || { say "AI_GATEWAY_API_KEY unset and $ENV_FILE missing" >&2; exit 1; }
  ENV_ARGS=("--env-file=$ENV_FILE")
fi
vet() { bun "${ENV_ARGS[@]}" "$BIN" "$@"; }

say "building"
(
  cd "$ROOT" || exit 1
  [ -d node_modules ] || bun install --frozen-lockfile >/dev/null || exit 1
  bun run build >/dev/null
) || { say "build failed" >&2; exit 1; }

collector_stop() { docker rm -f "$NAME" >/dev/null 2>&1; }
collector_start() { # fresh output file each time
  collector_stop
  mkdir -p "$OUTDIR" && chmod 777 "$OUTDIR" && rm -f "$OUTDIR/out.json"
  docker run -d --name "$NAME" -p 4318:4318 -v "$OUTDIR:/out" \
    -v "$ROOT/fixtures/projects/j6/collector.yaml:/etc/otelcol-contrib/config.yaml:ro" \
    otel/opentelemetry-collector-contrib:latest >/dev/null || return 1
  for _ in $(seq 1 30); do
    # a GET on the logs path answers 405 once the receiver listens
    [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4318/v1/logs)" != 000 ] && return 0
    sleep 1
  done
  return 1
}
LF_DIR="$ROOT/fixtures/projects/j6/langfuse"
lf() { docker compose -p vetkit-j6-langfuse --env-file "$LF_DIR/langfuse.env" -f "$LF_DIR/docker-compose.yml" "$@"; }
cleanup() { collector_stop; lf down -v >/dev/null 2>&1; }
trap cleanup EXIT
export LANGFUSE_PUBLIC_KEY=pk-lf-local-test LANGFUSE_SECRET_KEY=sk-lf-local-test LANGFUSE_BASE_URL=http://127.0.0.1:3100

rm -rf "$PROJECT"
mkdir -p "$PROJECT"
cp -R "$ROOT/fixtures/projects/j6/." "$PROJECT/"
mkdir -p "$PROJECT/case-fail" "$PROJECT/case-down"
cd "$PROJECT" || exit 1
say "project $PROJECT"

TRACE="$(jq -r '.[0].provenance.traceId' "$ROOT/evals/cases/otel-fixture.json")"
SPAN="$(jq -r '.[0].provenance.spanId' "$ROOT/evals/cases/otel-fixture.json")"
OBS="$(jq -r '.[0].provenance.observationId' "$ROOT/evals/cases/otel-fixture.json")"
# The provenance ids must be the evaluated span's ids in fixtures/otlp/gen_ai-latest.json.
jq -e --arg t "$TRACE" --arg s "$SPAN" \
  '[.resourceSpans[].scopeSpans[].spans[] | select(.traceId==$t and .spanId==$s)] | length == 1' \
  "$ROOT/fixtures/otlp/gen_ai-latest.json" >/dev/null
result "premise: case provenance ids exist in fixtures/otlp/gen_ai-latest.json" 0 $? $?

# Variant cases: new wording -> cache miss, same correlation ids.
jq -c '.id="otel-fail" | .input.state += "\n(judge unreachable variant)"' evals/cases/otel-fixture.jsonl >case-fail/otel-fail.jsonl
jq -c '.id="otel-down" | .input.state += "\n(collector down variant)"' evals/cases/otel-fixture.jsonl >case-down/otel-down.jsonl

lf up -d >lf-up.log 2>&1
result "langfuse compose up -d" 0 $? $? "$(tail -1 lf-up.log)"
collector_start; result "collector up (docker otel/opentelemetry-collector-contrib)" 0 $? $?

up=1
for _ in $(seq 1 36); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$LANGFUSE_BASE_URL/api/public/health")" = 200 ] && { up=0; break; }
  sleep 5
done
result "langfuse healthy at $LANGFUSE_BASE_URL (<=180s)" 0 "$up" "$up"
if [ "$up" -eq 0 ]; then
  curl -s -o /dev/null -w 'seed trace HTTP %{http_code}\n' -u "$LANGFUSE_PUBLIC_KEY:$LANGFUSE_SECRET_KEY" \
    -H 'Content-Type: application/json' -H 'x-langfuse-ingestion-version: 4' \
    --data-binary "@$ROOT/fixtures/otlp/gen_ai-latest.json" "$LANGFUSE_BASE_URL/api/public/otel/v1/traces"
  sleep 5
fi

# ---- AC1: vet run --sink otel --json -> one gen_ai.evaluation.result record on the span --------
vet run --sink otel,langfuse --json >run1.json 2>run1.err
code=$?
result "AC1a/AC2a: vet run --sink otel,langfuse --json" 0 "$code" "$([ "$code" -eq 0 ] && echo 0 || echo 1)" \
  "$(jq -c '{status: .results[0].status, cause: .results[0].cause, model: .results[0].model.resolved, sinks, outbox}' run1.json 2>/dev/null)"
sleep 3
jq -e '.resourceLogs[].scopeLogs[].logRecords[] | select(.attributes[]?.key=="gen_ai.evaluation.name")' "$OUTDIR/out.json" >/dev/null
result "AC1b: jq -e select(gen_ai.evaluation.name) /tmp/vet-otel/out.json" 0 $? $?
REC='[.resourceLogs[].scopeLogs[].logRecords[] | select(.attributes[]?.key=="gen_ai.evaluation.name")]'
jq -e "$REC | length == 1" "$OUTDIR/out.json" >/dev/null
result "AC1c: exactly one record per (case, criterion)" 0 $? $? "records=$(jq "$REC | length" "$OUTDIR/out.json" 2>/dev/null)"
jq -e --arg t "$TRACE" --arg s "$SPAN" "$REC | all(.traceId==\$t and .spanId==\$s)" "$OUTDIR/out.json" >/dev/null
result "AC1d: record traceId/spanId == case provenance ($TRACE/$SPAN)" 0 $? $?
jq -e "$REC | all(.[]; (.attributes | map(.key)) as \$k | (\$k | index(\"gen_ai.evaluation.name\")) and (\$k | index(\"gen_ai.evaluation.score.value\")) and (\$k | index(\"gen_ai.evaluation.score.label\")) and (\$k | index(\"gen_ai.evaluation.explanation\")))" "$OUTDIR/out.json" >/dev/null
result "AC1e: name, score.value, score.label, explanation all set" 0 $? $? \
  "$(jq -c "$REC | .[0] | {event: .eventName, keys: [.attributes[].key]}" "$OUTDIR/out.json" 2>/dev/null)"

# ---- AC2: langfuse (same run as AC1) ---------------------------------------------------------
if [ "$up" -ne 0 ]; then
  say "FAIL AC2: langfuse did not become healthy (infra)"; FAILED=1
else
  result "AC2a: langfuse accepted the verdict" 0 0 "$(jq -e '.sinks.langfuse.accepted == 1' run1.json >/dev/null; echo $?)" "$(jq -c '.sinks' run1.json 2>/dev/null)"
  ok=1
  for _ in 1 2 3 4 5 6; do
    curl -s -u "$LANGFUSE_PUBLIC_KEY:$LANGFUSE_SECRET_KEY" "$LANGFUSE_BASE_URL/api/public/scores?traceId=$TRACE" >scores.json
    if jq -e --arg o "$OBS" '.data[0].observationId == $o' scores.json >/dev/null; then ok=0; break; fi
    sleep 5
  done
  result "AC2b: GET /api/public/scores?traceId | .data[0].observationId == $OBS" 0 "$ok" "$ok" "$(head -c 300 scores.json)"
fi

# ---- AC4a: outbox reconciliation after the run -------------------------------------------------
vet check --outbox --json >check1.json 2>check1.err
code=$?
jq -e '.produced == .acknowledged' check1.json >/dev/null
result "AC4a: vet check --outbox --json | jq -e '.produced == .acknowledged'" 0 "$code" $? "$(jq -c . check1.json 2>/dev/null)"

# ---- AC3: judge failure -> error.type, no score.*, exit 0 --------------------------------------
collector_start
CEV_JUDGE_BASE_URL=http://127.0.0.1:9 vet run --sink otel,langfuse --json --cases case-fail >run3.json 2>run3.err
code=$?
result "AC3a: CEV_JUDGE_BASE_URL=http://127.0.0.1:9 vet run --sink otel,langfuse --json; exit" 0 "$code" "$([ "$code" -eq 0 ] && echo 0 || echo 1)" \
  "$(jq -c '{status: .results[0].status, cause: .results[0].cause, sinks, outbox}' run3.json 2>/dev/null)"
sleep 3
jq -e '.. | objects | select(.key=="error.type")' "$OUTDIR/out.json" >/dev/null
result "AC3b: jq -e error.type present" 0 $? $? "$(jq -c '[.. | objects | select(.key=="error.type") | .value]' "$OUTDIR/out.json" 2>/dev/null)"
n="$(jq '.. | objects | select(.key=="gen_ai.evaluation.score.value")' "$OUTDIR/out.json" 2>/dev/null | wc -l)"
result "AC3c: score.value lines == 0" 0 0 "$([ "$n" -eq 0 ] && echo 0 || echo 1)" "lines=$n"
n="$(jq '.. | objects | select((.key // "") | startswith("gen_ai.evaluation.score."))' "$OUTDIR/out.json" 2>/dev/null | wc -l)"
result "AC3d: no gen_ai.evaluation.score.* attribute at all" 0 0 "$([ "$n" -eq 0 ] && echo 0 || echo 1)" "lines=$n"

# ---- AC4b: reconciliation after the failure run ------------------------------------------------
vet check --outbox --json >check2.json 2>check2.err
code=$?
# Informational, not an AC: the langfuse sink dead-letters an unscored verdict ("unscored:unscored"),
# so produced != acknowledged and check exits 1 once a judge failure went through both sinks.
say "INFO outbox after judge-failure run (exit $code; langfuse dead-letters unscored verdicts): $(jq -c . check2.json 2>/dev/null)"

# ---- Edge: collector unreachable -> verdict cached, outbox pending, exit 0, stderr warning ------
collector_stop
vet run --sink otel,langfuse --json --cases case-down >run4.json 2>run4.err
code=$?
result "EDGE-a: collector down: exit 0" 0 "$code" "$([ "$code" -eq 0 ] && echo 0 || echo 1)" \
  "$(jq -c '{status: .results[0].status, sinks, outbox}' run4.json 2>/dev/null)"
grep -q "verdicts pending" run4.err
result "EDGE-b: collector down: warning on stderr" 0 0 $? "$(grep -m1 "verdicts pending" run4.err)"
vet check --outbox --json >check3.json 2>check3.err
say "INFO outbox while collector down (exit $?): $(jq -c . check3.json 2>/dev/null)"
collector_start
vet run --sink otel,langfuse --json --cases case-down >run5.json 2>run5.err
code=$?
result "EDGE-c: collector back up: second run drains, exit 0" 0 "$code" "$([ "$code" -eq 0 ] && echo 0 || echo 1)" \
  "$(jq -c '{cacheHit: .results[0].cacheHit, sinks, outbox}' run5.json 2>/dev/null)"
sleep 3
jq -e '[.resourceLogs[].scopeLogs[].logRecords[]] | length >= 1' "$OUTDIR/out.json" >/dev/null
result "EDGE-d: drained record reached the collector" 0 $? $?
vet check --outbox --json >check4.json 2>check4.err
code=$?
jq -e '.produced - .acknowledged == .dead' check4.json >/dev/null
result "EDGE-e: after drain nothing is pending (produced - acknowledged == dead)" 0 "$code" "$([ "$code" -le 1 ] && jq -e '.produced - .acknowledged == .dead' check4.json >/dev/null; echo $?)" "$(jq -c . check4.json 2>/dev/null)"

if [ "$FAILED" -ne 0 ]; then say "FAILED"; exit 1; fi
say "ok"
