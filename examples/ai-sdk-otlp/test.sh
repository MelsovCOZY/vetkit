#!/usr/bin/env bash
# Keyless proof of the AI SDK -> OTLP http/json -> vet wiring: start `vet watch` on an OS-chosen
# port, run the app against it, stop watch with SIGINT and assert it saw and judged the trace.
set -euo pipefail
cd "$(dirname "$0")"

command -v jq >/dev/null 2>&1 || { echo "test.sh: jq is required" >&2; exit 1; }

rm -f watch.json watch.err
vet watch --sample 1 --port 0 --json --no-promote >watch.json 2>watch.err &
watch_pid=$!
trap 'kill "$watch_pid" 2>/dev/null || true' EXIT

port=""
for _ in $(seq 1 60); do
  port="$(sed -n 's/.*"listening":{"port":\([0-9][0-9]*\)}.*/\1/p' watch.err | head -n 1)"
  [ -n "$port" ] && break
  kill -0 "$watch_pid" 2>/dev/null || { cat watch.err >&2; echo "test.sh: vet watch exited early" >&2; exit 1; }
  sleep 0.5
done
[ -n "$port" ] || { cat watch.err >&2; echo "test.sh: vet watch never reported its port" >&2; exit 1; }

VET_OTLP_PORT="$port" node app.ts

kill -INT "$watch_pid"
wait "$watch_pid"

jq -e '.seen >= 1 and .judged >= 1' watch.json >/dev/null
echo "ai-sdk-otlp: watch saw and judged $(jq -r '.judged' watch.json) trace(s)"
