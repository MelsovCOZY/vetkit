#!/usr/bin/env bash
# J7 slice-gate smoke (bd classified-evals-mol-529): `vet watch` end to end against the REAL Jev
# judge (config transport: Vercel AI Gateway) and a REAL OpenTelemetry Collector (docker image
# otel/opentelemetry-collector-contrib, J6 gate recipe), traffic from scripts/replay-otlp.ts.
# Runs in a scratch copy of fixtures/projects/j7 so the fixture stays clean.
#
# Steps: build -> collector up -> port-busy edge (exit 2 names the port) -> run A (AC1 + AC3, sink
# otel) -> run B (AC2: fake sink `flaky` force-rejects 3 items, sink flaky) -> collector down.
# Judge calls: about sample-rate x 100 per run (two runs); keys are never printed.
#
# Usage: bash scripts/smoke-j7.sh        (env: AI_GATEWAY_API_KEY, or VETKIT_ENV_FILE for --env-file)
set -u

ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
BIN="$ROOT/packages/cli/dist/bin.js"
PROJECT="${VETKIT_SMOKE_DIR:-${TMPDIR:-/tmp}/vetkit-smoke-j7}"
ENV_FILE="${VETKIT_ENV_FILE:-$ROOT/.env}"
# The AC names port 4318; when another process already holds it, the bead allows 4319.
if [ -z "${J7_WATCH_PORT:-}" ]; then
  if ss -ltn 2>/dev/null | grep -q '127.0.0.1:4318 \|\*:4318 \|\[::\]:4318 '; then J7_WATCH_PORT=4319; else J7_WATCH_PORT=4318; fi
fi
WATCH_PORT="$J7_WATCH_PORT"
COLLECTOR_PORT="${J7_COLLECTOR_PORT:-4320}"
COLLECTOR_NAME="vetkit-j7-collector-$$"
FIXTURE_TRACE="$ROOT/fixtures/otlp/gen_ai-latest.json"
FAILED=0

say() { printf 'smoke-j7: %s\n' "$*"; }
result() { # <label> <expected> <observed-exit> <ok 0|1> [detail]
  local status=PASS
  if [ "$4" -ne 0 ]; then status=FAIL; FAILED=1; fi
  say "$status $1 (exit $3, expected $2)${5:+ - $5}"
}

ENV_ARGS=()
if [ -z "${AI_GATEWAY_API_KEY:-}" ]; then
  [ -f "$ENV_FILE" ] || { say "AI_GATEWAY_API_KEY is unset and $ENV_FILE does not exist" >&2; exit 1; }
  ENV_ARGS=("--env-file=$ENV_FILE")
fi
vet() { bun "${ENV_ARGS[@]}" "$BIN" "$@"; }

cleanup() {
  docker rm -f "$COLLECTOR_NAME" >/dev/null 2>&1
  [ -n "${WATCH_PID:-}" ] && kill -KILL "$WATCH_PID" >/dev/null 2>&1
  [ -n "${BUSY_PID:-}" ] && kill "$BUSY_PID" >/dev/null 2>&1
}
trap cleanup EXIT

say "building"
(
  cd "$ROOT" || exit 1
  if [ ! -d node_modules ]; then bun install --frozen-lockfile >/dev/null || exit 1; fi
  bun run build >/dev/null
) || { say "build failed" >&2; exit 1; }

# ---- collector (J6 gate recipe): otlp/http in, file exporter out --------------------------
COLLECTOR_DIR="$PROJECT-collector"
rm -rf "$PROJECT" "$COLLECTOR_DIR"
mkdir -p "$COLLECTOR_DIR/out"
chmod 777 "$COLLECTOR_DIR/out"
cat >"$COLLECTOR_DIR/config.yaml" <<'YAML'
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
exporters:
  file:
    path: /out/logs.json
service:
  pipelines:
    logs:
      receivers: [otlp]
      exporters: [file]
YAML
docker run -d --name "$COLLECTOR_NAME" -p "127.0.0.1:$COLLECTOR_PORT:4318" \
  -v "$COLLECTOR_DIR/config.yaml:/etc/otelcol/config.yaml:ro" -v "$COLLECTOR_DIR/out:/out" \
  otel/opentelemetry-collector-contrib:latest --config /etc/otelcol/config.yaml >/dev/null \
  || { say "collector failed to start" >&2; exit 1; }
for _ in $(seq 1 40); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' \
    -d '{"resourceLogs":[]}' "http://127.0.0.1:$COLLECTOR_PORT/v1/logs")
  [ "$code" = 200 ] && break
  sleep 0.5
done
[ "$code" = 200 ] || { say "collector not ready (last status $code)" >&2; exit 1; }
say "collector up on $COLLECTOR_PORT"

mkdir -p "$PROJECT"
cp -r "$ROOT/fixtures/projects/j7/." "$PROJECT/"
cd "$PROJECT" || exit 1
export J7_COLLECTOR_ENDPOINT="http://127.0.0.1:$COLLECTOR_PORT"
TODAY="$(date -u +%F)"

# hashToUnit per docs/contracts/j7.md, recomputed independently of the product.
sampled_expected() { # <traceIds json file> <rate>
  node -e '
    const { createHash } = require("node:crypto");
    const ids = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).traceIds;
    const u = (id) => Number(createHash("sha256").update(id).digest().readBigUInt64BE(0)) / 2 ** 64;
    console.log(ids.filter((id) => u(id) < Number(process.argv[2])).length);
  ' "$1" "$2"
}

wait_listening() { # <log file>
  for _ in $(seq 1 60); do grep -q '"listening"' "$1" 2>/dev/null && return 0; sleep 0.5; done
  return 1
}

# ---- edge: port busy -> exit 2 naming the port ---------------------------------------------
bun -e "Bun.serve({port: $WATCH_PORT, hostname: '127.0.0.1', fetch: () => new Response('busy')}); setInterval(() => {}, 1e6)" &
BUSY_PID=$!
sleep 1
vet watch --sample 0.1 --sink otel --json --port "$WATCH_PORT" >busy.out 2>busy.err
code=$?
result "edge: port busy -> vet watch exit 2 naming the port" 2 "$code" \
  "$([ "$code" -eq 2 ] && grep -q "$WATCH_PORT" busy.err busy.out && echo 0 || echo 1)"
kill "$BUSY_PID"; wait "$BUSY_PID" 2>/dev/null; BUSY_PID=
sleep 0.5

# ---- run A: AC1 + AC3 (sink otel) ------------------------------------------------------------
vet watch --sample 0.1 --sink otel --json --port "$WATCH_PORT" >watch.json 2>watch.err &
WATCH_PID=$!
wait_listening watch.err || { say "watch never listened" >&2; cat watch.err | head -5 >&2; exit 1; }
bun run "$ROOT/scripts/replay-otlp.ts" "$FIXTURE_TRACE" --count 100 --port "$WATCH_PORT" --inject-failure 1 >replay.json
rcode=$?
kill -INT "$WATCH_PID"
wait "$WATCH_PID"
wcode=$?
WATCH_PID=
INJECTED="$(jq -r '.injected[0]' replay.json)"
result "replay: 100 traces POSTed, none refused" 0 "$rcode" "$([ "$(jq '.sent' replay.json)" = 100 ] && echo 0 || echo 1)"
result "watch exits 0 on first SIGINT" 0 "$wcode" 0 "summary: $(jq -c . watch.json 2>/dev/null | head -c 300)"

jq -e . watch.json >/dev/null
result "AC1a: coverage summary on stdout parses as JSON" 0 $? $?

n=$(jq -s 'length' .vet/watch/inclusion.jsonl)
result "AC1b: jq -s 'length' .vet/watch/inclusion.jsonl == 100" 0 0 "$([ "$n" = 100 ] && echo 0 || echo 1)" "got $n"
s=$(jq -s 'map(select(.sampled)) | length' .vet/watch/inclusion.jsonl)
want=$(sampled_expected replay.json 0.1)
result "AC1c: sampled count == #ids with hashToUnit < 0.1" 0 0 "$([ "$s" = "$want" ] && echo 0 || echo 1)" "inclusion sampled=$s recomputed=$want summary.sampled=$(jq .sampled watch.json)"
result "AC1d: summary.seen == 100 and summary.sampled == recomputed" 0 0 \
  "$([ "$(jq .seen watch.json)" = 100 ] && [ "$(jq .sampled watch.json)" = "$want" ] && echo 0 || echo 1)"

result "AC1e: every sampled trace judged (summary.judged == sampled)" 0 0 \
  "$([ "$(jq .judged watch.json)" = "$s" ] && echo 0 || echo 1)" "judged=$(jq .judged watch.json) real-judge calls"

# AC3: promotion. Decision (c): pending/ path.
PROMOTED="evals/cases/pending/promoted-$TODAY.jsonl"
jq -e '.provenance.promotedFrom.traceId' "$PROMOTED" >/dev/null 2>&1
result "AC3a: jq -e '.provenance.promotedFrom.traceId' $PROMOTED" 0 $? $?
got="$(jq -r '.provenance.promotedFrom.traceId' "$PROMOTED" 2>/dev/null | head -1)"
result "AC3b: promoted traceId == injected failing trace" 0 0 "$([ "$got" = "$INJECTED" ] && echo 0 || echo 1)" "promoted=$got injected=$INJECTED lines=$(wc -l <"$PROMOTED" 2>/dev/null)"

# AC2 part 1 (sink otel): the outbox reconciles and the real collector received the records.
vet check --outbox --json >check-a.json 2>/dev/null
jq -e '.produced == .acknowledged and .produced > 0' check-a.json >/dev/null
result "AC2a (otel run): vet check --outbox --json | jq -e '.produced == .acknowledged'" 0 $? $? "$(jq -c . check-a.json)"
sleep 1
recv=$(cat "$COLLECTOR_DIR/out/logs.json" 2>/dev/null | jq -s '[.[].resourceLogs[]?.scopeLogs[]?.logRecords[]?] | length' 2>/dev/null)
ack=$(jq .acknowledged check-a.json)
result "AC2a2: collector received as many log records as acknowledged" 0 0 "$([ "${recv:-0}" = "$ack" ] && echo 0 || echo 1)" "collector=$recv acknowledged=$ack"

# ---- run B: AC2 with the fake sink force-rejecting 3 items ----------------------------------
rm -rf .vet evals/cases/pending
export VETKIT_FIXTURE_REJECT=3 VETKIT_FIXTURE_SINK_LOG="$PWD/flaky.log"
vet watch --sample 0.1 --sink flaky --json --port "$WATCH_PORT" >watch-b.json 2>watch-b.err &
WATCH_PID=$!
wait_listening watch-b.err || { say "watch B never listened" >&2; exit 1; }
bun run "$ROOT/scripts/replay-otlp.ts" "$FIXTURE_TRACE" --count 100 --port "$WATCH_PORT" --seed b >replay-b.json
kill -INT "$WATCH_PID"
wait "$WATCH_PID"
wcode=$?
WATCH_PID=
unset VETKIT_FIXTURE_REJECT VETKIT_FIXTURE_SINK_LOG
result "run B: watch exits 0" 0 "$wcode" 0 "summary: $(jq -c . watch-b.json 2>/dev/null | head -c 300)"
vet check --outbox --json >check-b.json 2>/dev/null
code=$?
jq -e '.produced == .acknowledged and .produced > 0' check-b.json >/dev/null
result "AC2b: vet check --outbox --json | jq -e '.produced == .acknowledged'" 0 $? $? "$(jq -c . check-b.json) exit=$code"
rej=$(jq -s 'map(.rejected) | add' flaky.log 2>/dev/null)
result "AC2c: the fake sink really rejected 3 items before accepting" 0 0 "$([ "$rej" = 3 ] && echo 0 || echo 1)" "rejected=$rej"

if [ "$FAILED" -ne 0 ]; then
  say "FAILED (scratch project: $PROJECT)"
  exit 1
fi
say "ok"
