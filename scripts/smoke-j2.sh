#!/usr/bin/env bash
# J2 slice-gate smoke (bd classified-evals-mol-hzv): `vet init --source fixtures/traces/` with the
# REAL generator and REAL Jev judge, then lint the generated file and every lint-bad fixture, then
# `vet run` on the generated set. Prints one PASS/FAIL line per acceptance-criterion step.
#
# Live calls: one init (generator: <= 3 + ceil(traces/20) calls; judge: dedupe only) and one
# `vet run` (one judge request per criterion x case, batched). A GENERATOR_UNAVAILABLE init is
# retried once. The init output is generated ONCE; AC1 and AC6 read the same --json document.
#
# Keys: AI_GATEWAY_API_KEY / GEMINI_API_KEY from the environment, else from VETKIT_ENV_FILE
# (default: the repo .env) via `bun --env-file`. Never printed; no request/response bodies logged.
#
# Usage: bash scripts/smoke-j2.sh   (VETKIT_SMOKE_DIR overrides the scratch dir)
set -u

ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
WORK="${VETKIT_SMOKE_DIR:-${TMPDIR:-/tmp}/vetkit-smoke-j2}"
ENV_FILE="${VETKIT_ENV_FILE:-$ROOT/.env}"
BIN="$ROOT/packages/cli/dist/bin.js"
PROJECT="$ROOT/fixtures/projects/j2"
OUT="$WORK/j2"
FAILED=0

say() { printf 'smoke-j2: %s\n' "$*"; }
result() { # <label> <expected> <observed-exit> <ok 0|1> [detail]
  local status=PASS
  if [ "$4" -ne 0 ]; then status=FAIL; FAILED=1; fi
  say "$status $1 (exit $3, expected $2)${5:+ - $5}"
}

ENV_ARGS=()
if [ -z "${AI_GATEWAY_API_KEY:-}" ] || { [ -z "${GEMINI_API_KEY:-}" ] && [ "${VETKIT_J2_GENERATOR:-}" != gateway ]; }; then
  if [ ! -f "$ENV_FILE" ]; then
    say "keys are unset and $ENV_FILE does not exist" >&2
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

rm -rf "$WORK"
mkdir -p "$WORK"

# Step 1: init. Runs from the config fixture directory (vetkit.config.ts is read from cwd).
cd "$PROJECT" || exit 1
vet init --source "$ROOT/fixtures/traces/" --out "$OUT" --json >"$WORK/init.json" 2>"$WORK/init.err"
code=$?
if [ "$code" -ne 0 ] && grep -q GENERATOR_UNAVAILABLE "$WORK/init.err" "$WORK/init.json"; then
  say "generator unavailable; retrying init once"
  vet init --source "$ROOT/fixtures/traces/" --out "$OUT" --force --json >"$WORK/init.json" 2>"$WORK/init.err"
  code=$?
fi
jq -e '(.criteria|length)>=5 and (.cases|length)>=20 and all(.criteria[]; .escape!="" and (.provenance.traceIds|length)>0)' \
  "$WORK/init.json" >/dev/null
ok=$?
result "AC1: vet init --source fixtures/traces/ --out <out> --json | jq -e '>=5 criteria, >=20 cases, escape, provenance'" 0 "$code" "$ok" \
  "criteria=$(jq '.criteria|length' "$WORK/init.json" 2>/dev/null) cases=$(jq '.cases|length' "$WORK/init.json" 2>/dev/null) types=$(jq -c '[.criteria[].type]|group_by(.)|map({(.[0]):length})|add' "$WORK/init.json" 2>/dev/null)"
if [ "$code" -ne 0 ] || [ "$ok" -ne 0 ]; then
  say "init stderr: $(grep -vi 'key' "$WORK/init.err" | head -3 | tr '\n' ' ')"
fi
if [ ! -f "$OUT/criteria.yaml" ]; then
  say "FAILED (no criteria.yaml written; later steps skipped)"
  exit 1
fi
ls "$OUT/cases"/*.jsonl >/dev/null 2>&1
result "AC1b: <out>/criteria.yaml and <out>/cases/*.jsonl exist" 0 0 "$?"

# AC6: generated cases carry no reference (same init document).
jq -e 'all(.cases[]; has("expected") | not)' "$WORK/init.json" >/dev/null
result "AC6: init --json | jq -e 'all(.cases[]; has(\"expected\")|not)'" 0 0 "$?"

# Step 2a (AC2): lint the generated file -> 0.
vet lint "$OUT/criteria.yaml" >"$WORK/lint-gen.txt" 2>&1
code=$?
result "AC2a: vet lint <out>/criteria.yaml" 0 "$code" "$([ "$code" -eq 0 ] && echo 0 || echo 1)" "$(head -1 "$WORK/lint-gen.txt")"

# Step 2b (AC2, AC5): every lint-bad fixture exits 1 and names its rule id. Owner decision:
# DEEP_INDIRECTION is warn-only, so deep-indirection.yaml exits 0 and still names the rule.
count="$(ls "$ROOT"/fixtures/lint-bad/*.yaml | wc -l)"
result "AC5a: ls fixtures/lint-bad/*.yaml | wc -l >= 10" ">=10" 0 "$([ "$count" -ge 10 ] && echo 0 || echo 1)" "count=$count"
for f in "$ROOT"/fixtures/lint-bad/*.yaml; do
  name="$(basename "$f" .yaml)"
  rule="$(printf '%s' "$name" | tr 'a-z-' 'A-Z_')"
  want=1
  [ "$rule" = DEEP_INDIRECTION ] && want=0
  vet lint "$f" >"$WORK/lint-$name.txt" 2>&1
  code=$?
  ok=1
  if [ "$code" -eq "$want" ] && grep -q "$rule" "$WORK/lint-$name.txt"; then ok=0; fi
  result "AC2/AC5: vet lint fixtures/lint-bad/$name.yaml names $rule" "$want" "$code" "$ok"
done

# Step 3 (AC3): vet run in the output directory. The AC needs "no loader or schema errors",
# so exit 0 or 1 (threshold fails) both count; exit >= 2 is a usage/config/loader error.
cd "$OUT" || exit 1
vet run --json >"$WORK/run.json" 2>"$WORK/run.err"
code=$?
jq -e '.summary.total>=20' "$WORK/run.json" >/dev/null
ok=$?
[ "$code" -ge 2 ] && ok=1
result "AC3: cd <out> && vet run --json | jq -e '.summary.total>=20'" "0|1" "$code" "$ok" \
  "summary=$(jq -c '.summary' "$WORK/run.json" 2>/dev/null | head -c 300)"
if [ "$ok" -ne 0 ]; then say "run stderr: $(head -3 "$WORK/run.err" | tr '\n' ' ')"; fi

if [ "$FAILED" -ne 0 ]; then
  say "FAILED"
  exit 1
fi
say "ok"
