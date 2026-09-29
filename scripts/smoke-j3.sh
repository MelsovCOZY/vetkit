#!/usr/bin/env bash
# J3 slice-gate smoke: import labels, calibrate, write
# criteria.lock.json and gate on it, against the REAL Jev judge through the vercel preset.
#
# Projects (all scratch copies; the repo fixtures are never written to):
#   P1 = fixtures/projects/j3            answer_correct (boolean, reference grader) + answer_quality
#                                        (score); trimmed gauntlet corpora (fixtures/projects/j3/gauntlet:
#                                        all 13 injection families, 4 master keys, 1 padding), because the
#                                        judge upstream answers 429 "high demand" under bulk load.
#   P2 = fixtures/gauntlet-fail          thin_class, polarity_flip, persuasive_constant,
#                                        needs_reference; no generator and only the constant-output
#                                        corpus, so the expensive gauntlets are skipped (not the point of P2).
#   P3 = P1 with CEV_JUDGE_BASE_URL=http://127.0.0.1:9   judge refuses connections (edge case).
# Labels are a GATE-ONLY synthetic seed (fixtures/projects/j3/seed.mjs), never a shipped path.
#
# Cost: dominated by P1's gauntlets (thousands of judge requests); every vet call runs under
# CEV_DIAG=1 and the script prints the summed judge request count at the end. The generator
# (paraphrase + polarity wordings) is an OpenAI-compatible model on the same gateway key
# (CEV_J3_GENERATOR_MODEL, default anthropic/claude-haiku-4.5): a handful of calls per criterion.
#
# Key: AI_GATEWAY_API_KEY from the environment, else from VETKIT_ENV_FILE (default: the repo
# .env) via `bun --env-file`. The key is never printed, and neither are judge bodies.
#
# Dry run (no network, plumbing only): VETKIT_SMOKE_CONFIG=<vetkit.config.ts with an in-process
# judge> replaces the project configs and skips the preflight; the CEV_JUDGE_BASE_URL edge then
# reports FAIL, as that env var only reaches real transports.
#
# Usage: bash scripts/smoke-j3.sh        (exit 0 only when every AC step passed)
set -u

ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
WORK="${VETKIT_SMOKE_DIR:-${TMPDIR:-/tmp}/vetkit-smoke-j3}"
ENV_FILE="${VETKIT_ENV_FILE:-$ROOT/.env}"
BIN="$ROOT/packages/cli/dist/bin.js"
FAILED=0

say() { printf 'smoke-j3: %s\n' "$*"; }
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
DIAG_LOG="$WORK/diag.log"
# vet <outfile-stem> args... : stdout -> <stem>.out, stderr -> <stem>.err, diag line -> diag.log.
vet() {
  local stem="$1"
  shift
  CEV_DIAG=1 timeout 3000 bun "${ENV_ARGS[@]}" "$BIN" "$@" >"$stem.out" 2>"$stem.err"
  local code=$?
  grep -h '^{"diag"' "$stem.err" >>"$DIAG_LOG" 2>/dev/null
  return $code
}

say "building"
(
  cd "$ROOT" || exit 1
  if [ ! -d node_modules ]; then bun install --frozen-lockfile >/dev/null || exit 1; fi
  bun run build >/dev/null
) || { say "build failed" >&2; exit 1; }

# Preflight: the judge upstream answers 429 "high demand" when it is busy (shared gateway key).
# Wait for one 200 on the recorded refund request (up to ~10 minutes) so the run below measures
# vetkit, not the queue. Only the HTTP status is printed.
if [ -z "${AI_GATEWAY_API_KEY:-}" ]; then
  KEY="$(bun "${ENV_ARGS[@]}" -e 'process.stdout.write(process.env.AI_GATEWAY_API_KEY ?? "")')"
else
  KEY="$AI_GATEWAY_API_KEY"
fi
status=000
[ -n "${VETKIT_SMOKE_CONFIG:-}" ] && status=200
for _ in $(seq 1 30); do
  [ "$status" = 200 ] && break
  status="$(curl -s -o /dev/null -w '%{http_code}' https://ai-gateway.vercel.sh/typesafe/v1/systemone \
    -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
    -d @"$ROOT/docs/research/fixtures/2026-09-25-gateway-systemone-request.json")"
  [ "$status" = 200 ] && break
  sleep 20
done
unset KEY
say "preflight judge HTTP $status"
if [ "$status" != 200 ]; then
  say "NOT RUN: the judge upstream never answered 200 (last HTTP $status; external, retry later)" >&2
  exit 3
fi

rm -rf "$WORK"
mkdir -p "$WORK/p1" "$WORK/p2" "$WORK/p3"
: >"$DIAG_LOG"
FIX="$ROOT/fixtures"

# ---------------------------------------------------------------- P1: label + validate
cp "${VETKIT_SMOKE_CONFIG:-$FIX/projects/j3/vetkit.config.ts}" "$WORK/p1/vetkit.config.ts"
cp -r "$FIX/projects/j3/evals" "$FIX/projects/j3/criteria.active.yaml" "$WORK/p1/"
cd "$WORK/p1" || exit 1
say "P1 $WORK/p1"

vet l1 label --from "$FIX/labels/"
code=$?
rows_ok=0
for id in answer_correct answer_quality thin_class; do
  [ "$(($(wc -l <"evals/labels/$id.csv") - 1))" -ge 100 ] || rows_ok=1
done
result "AC-smoke: vet label --from fixtures/labels/ (>=100 rows per labels file)" 0 "$code" "$rows_ok"

vet v1 validate --json --repeats 3 --gauntlet "$FIX/projects/j3/gauntlet"
code=$?
jq -e '.criteria | length >= 1' v1.out >/dev/null
result "AC-smoke: vet validate --json | jq -e '.criteria | length >= 1' (v1.out stands for /tmp/validate.json)" 0 "$code" "$?" \
  "$(jq -c '[.criteria[] | {id, status, reasons}]' v1.out 2>/dev/null)"
if [ ! -f criteria.lock.json ]; then
  say "FAIL criteria.lock.json was not written"
  FAILED=1
fi

# AC1: one status per criterion, all eight gauntlet keys, threshold/TPR/TNR/ECE, reasons[].
statuses="$(jq -r '.criteria[].status' criteria.lock.json 2>/dev/null | tr '\n' ' ')"
n_crit="$(jq '.criteria | length' criteria.lock.json 2>/dev/null)"
n_status="$(jq -r '.criteria[].status' criteria.lock.json 2>/dev/null | grep -Ec '^(calibrated|uncalibrated|floating)$')"
[ "${n_crit:-0}" -ge 1 ] && [ "$n_crit" = "$n_status" ]
result "AC1a: jq '.criteria[].status' criteria.lock.json -> one status per criterion" 0 0 "$?" "$statuses"
jq -e '[.criteria[].gauntlet | keys] | all(. == ["constant_output","injection","label_permutation","length","master_key","paraphrase","polarity","position_swap"])' \
  criteria.lock.json >/dev/null
result "AC1b: jq '.criteria[].gauntlet | keys' lists all eight" 0 0 "$?" \
  "$(jq -c '.criteria.answer_correct.gauntlet' criteria.lock.json 2>/dev/null)"
jq -e '.criteria.answer_correct | has("threshold") and has("tpr") and has("tnr") and has("ece") and has("reasons") and (.reasons|type)=="array"' \
  criteria.lock.json >/dev/null
result "AC1c: lock entry has threshold, tpr, tnr, ece, reasons[]" 0 0 "$?" \
  "$(jq -c '.criteria | map_values({status, threshold, tpr, tnr, ece, reasons})' criteria.lock.json 2>/dev/null)"

# AC6: new statistics in the validate report.
jq -e '.criteria[0] | has("correctedPassRate") and has("se") and has("byLanguage") and ((.detail.injection.families | length) >= 13) and (.detail.length | has("lengthVerdictCorrelation"))' \
  v1.out >/dev/null
result "AC6: validate report statistics (correctedPassRate, se, byLanguage, >=13 injection families, lengthVerdictCorrelation)" 0 0 "$?" \
  "families=$(jq '.criteria[0].detail.injection.families | length' v1.out 2>/dev/null)"

# ---------------------------------------------------------------- P1: gate on a score criterion + pin gate
mkdir passcases
grep '"id":"j3-p-' evals/cases/j3.jsonl | head -6 >passcases/pass.jsonl

vet g1 run --gate --json --allow-unpinned --cases passcases
code=$?
jq -e '[.results[] | select(.criterionId=="answer_quality") | .gated] | length > 0 and all(. == false)' g1.out >/dev/null
gated_ok=$?
jq -e '[.results[] | select(.criterionId=="answer_quality") | .gateReason] | all(. == "score_not_gateable")' g1.out >/dev/null
reason_ok=$?
jq -e '.criteria.answer_quality | .status == "uncalibrated" and (.reasons | index("score_not_gateable") != null)' criteria.lock.json >/dev/null
lock_ok=$?
# Exit follows the boolean criterion only: 0 iff every answer_correct verdict passed.
want=0
jq -e '[.results[] | select(.criterionId=="answer_correct") | .status=="ok" and .pass==true] | all' g1.out >/dev/null || want=1
[ "$(jq -r '.exitCode' g1.out 2>/dev/null)" = "$code" ] && [ "$code" -ne 2 ] && [ "$code" = "$want" ]
follow_ok=$?
result "AC5: vet run --gate --json (score never gates; exit follows boolean only; lock entry uncalibrated/score_not_gateable)" \
  "$want" "$code" "$((gated_ok | reason_ok | lock_ok | follow_ok))" \
  "gated=$gated_ok gateReason=$reason_ok lockEntry=$lock_ok exitFollowsBoolean=$follow_ok; stderr: $(grep -m1 'gate refused' g1.err)"

vet c1 run --ci --cases passcases
code=$?
grep -Eq 'GATE_UNPINNED' c1.err c1.out
named=$?
result "AC3a: vet run --ci (unpinned lock) -> exit 2 naming GATE_UNPINNED" 2 "$code" "$([ "$code" -eq 2 ] && echo "$named" || echo 1)" \
  "$(grep -m1 -Ei 'unpinned' c1.err)"
vet c2 run --ci --allow-unpinned --cases passcases
code=$?
result "AC3b: vet run --ci --allow-unpinned -> exit 0" 0 "$code" "$([ "$code" -eq 0 ] && echo 0 || echo 1)" \
  "$(head -1 c2.err)"

# vet check --lock: fresh, then stale after a wording edit (on the enabled criteria; see the
# probe below for the disabled one).
vet k0 check --lock --json
code=$?
say "FINDING vet check --lock --json with the disabled criterion thin_class (exit $code): $(jq -c '{stale, reasons, staleCriteria}' k0.out 2>/dev/null)"
vet k1 check --lock --json --criteria criteria.active.yaml
code=$?
jq -e '.stale == false' k1.out >/dev/null
result "AC-check-a: vet check --lock --json -> {stale:false}" 0 "$code" "$?" "$(jq -c '{stale, reasons}' k1.out 2>/dev/null)"
sed -i 's/^    instructions: Does the answer state the same fact as the reference answer to the question?$/    instructions: Does the answer state the very same fact as the reference answer to the question?/' criteria.active.yaml
vet k2 check --lock --json --criteria criteria.active.yaml
code=$?
jq -e '.stale == true and .reasons == ["wordingHash"]' k2.out >/dev/null
shape=$?
result "AC-check-b: after editing one instruction, vet check --lock --json -> {stale:true, reasons:[wordingHash]}" 1 "$code" \
  "$([ "$code" -eq 1 ] && echo "$shape" || echo 1)" "$(jq -c '{stale, reasons}' k2.out 2>/dev/null)"

# ---------------------------------------------------------------- P2: planted failures
cp "${VETKIT_SMOKE_CONFIG:-$FIX/gauntlet-fail/vetkit.config.ts}" "$WORK/p2/vetkit.config.ts"
mkdir -p "$WORK/p2/evals"
cp "$FIX/gauntlet-fail/criteria.yaml" "$WORK/p2/evals/criteria.yaml"
cp -r "$FIX/gauntlet-fail/cases" "$WORK/p2/evals/cases"
cd "$WORK/p2" || exit 1
say "P2 $WORK/p2"
vet l2a label --from "$FIX/labels/thin-class.csv"
c1=$?
vet l2b label --from "$FIX/gauntlet-fail/labels/"
c2=$?
result "P2 setup: vet label --from thin-class.csv and gauntlet-fail/labels/" 0 "$((c1 | c2))" "$((c1 | c2))"
vet v2 validate --json --repeats 3 --gauntlet "$FIX/gauntlet-fail/corpora"
code=$?
result "P2: vet validate --json" 0 "$code" "$code" "$(jq -c '[.criteria[] | {id, status, reasons}]' v2.out 2>/dev/null)"
say "reasons (jq -r '.criteria[] | select(.status==\"uncalibrated\") | .reasons[]'): $(jq -r '.criteria[] | select(.status=="uncalibrated") | .reasons[]' criteria.lock.json 2>/dev/null | sort | uniq -c | tr '\n' ' ')"
for pair in thin_class:class_too_small persuasive_constant:constant_output needs_reference:reference_missing; do
  id="${pair%%:*}"
  reason="${pair##*:}"
  jq -e --arg id "$id" --arg r "$reason" '.criteria[$id] | .status == "uncalibrated" and (.reasons | index($r) != null)' criteria.lock.json >/dev/null
  result "AC-reasons: $id is uncalibrated with reason $reason" 0 0 "$?" "$(jq -c --arg id "$id" '.criteria[$id] | {status, reasons}' criteria.lock.json 2>/dev/null)"
done
jq -e '.criteria.polarity_flip.status == "uncalibrated"' criteria.lock.json >/dev/null
result "AC2-lock: planted polarity_flip is uncalibrated" 0 0 "$?" "$(jq -c '.criteria.polarity_flip | {status, reasons, gauntlet}' criteria.lock.json 2>/dev/null)"

# AC2: the gate refuses and names the planted criterion (its own criteria file, since the
# refusal names the first uncalibrated id in sorted order).
vet g2 run --gate --allow-unpinned --criteria "$FIX/gauntlet-fail/polarity-flip.criteria.yaml"
code=$?
grep -q polarity_flip g2.err
named=$?
result "AC2: vet run --gate (polarity_flip suite) -> exit 2, stderr names polarity_flip" 2 "$code" \
  "$([ "$code" -eq 2 ] && echo "$named" || echo 1)" "$(grep -m1 'gate refused' g2.err)"
vet g3 run --gate --allow-unpinned
code=$?
result "AC2-full: vet run --gate (all P2 criteria) -> exit 2" 2 "$code" "$([ "$code" -eq 2 ] && echo 0 || echo 1)" "$(grep -m1 'gate refused' g3.err)"

# ---------------------------------------------------------------- P3: judge unavailable
# A refused connection (CEV_JUDGE_BASE_URL=http://127.0.0.1:9) is retried with backoff, so a
# full `vet validate` outage run would take hours; the edge is checked on one `vet run` case
# (owner decision (e): cause JUDGE_UNAVAILABLE). The validate-outage edge is NOT RUN here.
cd "$WORK/p1" || exit 1
say "P3 vet run with CEV_JUDGE_BASE_URL=http://127.0.0.1:9"
mkdir onecase
head -1 passcases/pass.jsonl >onecase/one.jsonl
CEV_JUDGE_BASE_URL=http://127.0.0.1:9 vet u1 run --json --cases onecase
code=$?
jq -e '[.results[] | select(.criterionId=="answer_correct") | .status == "unscored" and (.cause | tostring | test("JUDGE_UNAVAILABLE"))] | all' u1.out >/dev/null
shape=$?
result "Edge: refused judge connection -> verdict unscored with cause JUDGE_UNAVAILABLE, run exits 1" 1 "$code" \
  "$([ "$code" -eq 1 ] && echo "$shape" || echo 1)" \
  "$(jq -c '[.results[] | select(.criterionId=="answer_correct") | {status, cause}]' u1.out 2>/dev/null)"
say "NOT RUN Edge: judge 5xx during vet validate (retry backoff makes an outage run impractical; covered by leaf tests)"
say "NOT RUN Edge: missing generator key -> paraphrase skipped (the generator shares AI_GATEWAY_API_KEY with the judge)"

# ---------------------------------------------------------------- summary
total="$(cat "$DIAG_LOG" | jq -s '[.[].diag.judge.requests] | add // 0')"
say "judge requests (CEV_DIAG, all vet calls): $total"
say "artifacts: $WORK (validate reports: p1/v1.out, p2/v2.out, p3/v3.out)"
if [ "$FAILED" -ne 0 ]; then
  say "FAILED"
  exit 1
fi
say "ok"
