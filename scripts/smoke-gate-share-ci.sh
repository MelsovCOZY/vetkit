#!/usr/bin/env bash
# One smoke pass over three journeys, offline, with the in-process fake judge from
# fixtures/cli/run (no key, no network, no GitHub):
#   share  a result you can paste: Markdown/HTML report, run record, badge, no leaked key
#   gate   the path from an uncalibrated label to the calibrated gate, with cost shown first and
#          offline record/replay
#   ci     the one-snippet CI journey: action/run.sh install and run, annotations, job summary and
#          the sticky comment (through a stub `gh`)
# One shared build, one scratch root. Every assertion prints
# `smoke-gate-share-ci: PASS|FAIL <label> (exit N, expected M)`.
#
# Usage: bash scripts/smoke-gate-share-ci.sh   (env: VETKIT_SMOKE_DIR to choose and keep the scratch root)
set -u

ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
BIN="$ROOT/packages/cli/dist/bin.js"
BASE="${VETKIT_SMOKE_DIR:-${TMPDIR:-/tmp}/vetkit-smoke-gate-share-ci}"
FAILED=0
# The scratch root is removed on exit, pass or fail, when it is this script's default. A
# directory the caller named with VETKIT_SMOKE_DIR is the caller's to keep.
cleanup() { [ -z "${VETKIT_SMOKE_DIR:-}" ] && rm -rf "$BASE" "$BASE.out" "$BASE.err"; return 0; }
trap cleanup EXIT

say() { printf 'smoke-gate-share-ci: %s\n' "$*"; }
result() { # <label> <expected> <observed-exit> <ok 0|1> [detail]
  local status=PASS
  if [ "$4" -ne 0 ]; then status=FAIL; FAILED=1; fi
  say "$status $1 (exit $3, expected $2)${5:+ - $5}"
}
# assert <label> <shell snippet>: PASS when the snippet exits 0.
assert() {
  local code
  eval "$2" >/dev/null 2>&1
  code=$?
  result "$1" 0 "$code" "$code"
}
# run <expected exit> <args...>: runs the built CLI in the current directory, stdout to
# $OUT, stderr to $ERR, exit code to $CODE.
OUT="$BASE.out"
ERR="$BASE.err"
CODE=0
run() {
  node "$BIN" "$@" >"$OUT" 2>"$ERR"
  CODE=$?
}
# expect <label> <expected exit>: records the exit code of the last run().
expect() { result "$1" "$2" "$CODE" "$([ "$CODE" -eq "$2" ] && echo 0 || echo 1)"; }

finish() {
  if [ "$FAILED" -ne 0 ]; then
    if [ -n "${VETKIT_SMOKE_DIR:-}" ]; then
      say "FAILED; scratch files are in $BASE" >&2
    else
      say "FAILED; set VETKIT_SMOKE_DIR to keep the scratch files" >&2
    fi
    exit 1
  fi
  say ok
}

say "building"
(
  cd "$ROOT" || exit 1
  bun run build >/dev/null
) || { say "build failed" >&2; exit 1; }

rm -rf "$BASE" "$BASE.out" "$BASE.err"
mkdir -p "$BASE"

# ---- share --------------------------------------------------------------------------------
say "section: share"
SHARE="$BASE/share"
mkdir -p "$SHARE"
cp -r "$ROOT/fixtures/cli/run/." "$SHARE"
cd "$SHARE" || exit 1
export NO_COLOR=1
export VETKIT_FIXTURE_MODE=fail
export VETKIT_FIXTURE_KEY=smoke-share-canary-key-0123456789-abcdef
export AI_GATEWAY_API_KEY="$VETKIT_FIXTURE_KEY"
VERSION="$(node "$BIN" --version)"

run run --json --reporter junit=vet-junit.xml,md=.vet/report.md,html=.vet/report.html
expect "share: run --json with junit, md and html reporters (fail mode)" 1

assert "share: latest.json, one dated record, report.md, report.html, badge.json and vet-junit.xml exist and are non-empty" \
  '[ -s .vet/runs/latest.json ] && [ "$(ls .vet/runs/20*.json | wc -l)" -eq 1 ] && [ -s .vet/report.md ] && [ -s .vet/report.html ] && [ -s .vet/badge.json ] && [ -s vet-junit.xml ]'
assert "share: latest.json is identical to the dated record" \
  'cmp .vet/runs/latest.json .vet/runs/20*.json'
assert "share: the run record names its schema" \
  "jq -e '.\"\$schema\" | test(\"run-record.schema.json\$\")' .vet/runs/latest.json"
assert "share: the run record carries the criteria path, cases path and gateRequested false" \
  "jq -e '.criteriaPath == \"evals/criteria.yaml\" and .casesPath == \"evals/cases\" and .gateRequested == false' .vet/runs/latest.json"

for needle in '### vetkit eval report' '0 passed' '1 failed' 'Is the reply polite?' 'uncalibrated' \
  'fake-jev-fail-resolved' 'pinned: false' 'Dataset' "vetkit $VERSION" 'https://github.com/MelsovCOZY/vetkit'; do
  assert "share: report.md contains '$needle'" 'grep -qF -- "$needle" .vet/report.md'
done
for needle in '<!--' '<script' 'demo run' 'Hello! How can I help?' "$VETKIT_FIXTURE_KEY"; do
  assert "share: report.md does not contain '${needle%%-canary*}'" '! grep -qF -- "$needle" .vet/report.md'
done

assert "share: report.html starts with <!doctype html>" '[ "$(head -c 15 .vet/report.html)" = "<!doctype html>" ]'
assert "share: report.html contains the wording and uncalibrated" \
  "grep -qF 'Is the reply polite?' .vet/report.html && grep -qF uncalibrated .vet/report.html"
assert "share: report.html contains no script" '! grep -qi "<script" .vet/report.html'
assert "share: report.html loads nothing from outside github.com/MelsovCOZY/vetkit and schemas/" \
  '[ -z "$(grep -Eo "https?://[^\"<> ]+" .vet/report.html | grep -v github.com/MelsovCOZY/vetkit | grep -v schemas/)" ]'

assert "share: badge.json is a red 'uncalibrated · fail' shields endpoint" \
  "jq -e '.schemaVersion == 1 and .label == \"vetkit\" and .color == \"red\" and .message == \"uncalibrated · fail\"' .vet/badge.json"
assert "share: the badge message carries no counts or percentages" \
  '! jq -r .message .vet/badge.json | grep -E "[0-9]+/[0-9]+ pass|%"'
assert "share: the fixture key is in no report, record or junit file" \
  '! grep -rF -- "$VETKIT_FIXTURE_KEY" .vet vet-junit.xml'

run report --include-cases --md with-cases.md --html with-cases.html
expect "share: report --include-cases writes both files" 0
assert "share: with-cases.md contains the case content" "grep -qF 'Hello! How can I help?' with-cases.md"
assert "share: with-cases files do not contain the key" \
  '! grep -qF -- "$VETKIT_FIXTURE_KEY" with-cases.md with-cases.html'

assert "share: report --stdout starts with the report heading" \
  '[ "$(node "$BIN" report --stdout | head -1)" = "### vetkit eval report" ]'

VETKIT_FIXTURE_MODE=pass run run --json
expect "share: run --json in pass mode" 0
assert "share: a second dated record exists" '[ "$(ls .vet/runs/20*.json | wc -l)" -eq 2 ]'
assert "share: badge is yellow 'uncalibrated · pass'" \
  "[ \"\$(jq -r .message .vet/badge.json)\" = 'uncalibrated · pass' ] && [ \"\$(jq -r .color .vet/badge.json)\" = yellow ]"

# The demo label comes from the real demoJudge export, resolved through a node_modules symlink.
DEMO="$BASE/share-demo"
mkdir -p "$DEMO/node_modules"
cp -r "$ROOT/fixtures/cli/run/evals" "$DEMO/"
ln -s "$ROOT/packages/cli" "$DEMO/node_modules/vetkit"
printf "import { demoJudge } from 'vetkit';\nexport default { judge: demoJudge };\n" >"$DEMO/vetkit.config.ts"
( cd "$DEMO" && run run --reporter md; exit "$CODE" )
DEMO_CODE=$?
result "share: demo judge run" 0 "$DEMO_CODE" "$([ "$DEMO_CODE" -le 1 ] && echo 0 || echo 1)"
assert "share: demo report.md is labelled 'demo run'" "grep -qF 'demo run' '$DEMO/.vet/report.md'"
assert "share: demo badge is lightgrey 'demo · pass|fail'" \
  "jq -e '(.message | test(\"^demo · (pass|fail)\$\")) and .color == \"lightgrey\"' '$DEMO/.vet/badge.json'"
assert "share: demo run record has transport demo" \
  "jq -e '.model.transport == \"demo\"' '$DEMO/.vet/runs/latest.json'"

rm -rf .vet/runs
run report
expect "share: report without a run record" 2
assert "share: report without a run record says to run vet run first" 'grep -qF "run \`vet run\` first" "$ERR"'

# ---- gate ---------------------------------------------------------------------------------
say "section: gate"
GATE="$BASE/gate"
mkdir -p "$GATE"
unset AI_GATEWAY_API_KEY OPENROUTER_API_KEY TYPESAFE_API_KEY CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID
export VETKIT_FIXTURE_MODE=pass
export VETKIT_FIXTURE_KEY=sk-canary-do-not-print-7f3a
fresh() { # prints a new scratch copy of the run fixture
  local dir
  dir="$(mktemp -d "$GATE/p.XXXXXX")"
  cp -r "$ROOT/fixtures/cli/run/." "$dir"
  echo "$dir"
}

P="$(fresh)"
cd "$P" || exit 1
run run --json
expect "gate: run --json with no lock" 0
assert "gate: --json gate is uncalibrated with no lock path" \
  "jq -e '.gate.tier == \"uncalibrated\" and .gate.lockPath == null' '$OUT'"
run run
assert "gate: pretty run prints the gate: uncalibrated line" 'grep -q "^gate: uncalibrated" "$OUT"'
run run --gate
expect "gate: run --gate with no lock" 2
assert "gate: the refusal names criteria.lock.json" 'grep -qF criteria.lock.json "$ERR"'

# The real demoJudge is never gateable and never locked.
D="$(fresh)"
rm "$D/vetkit.config.ts"
mkdir -p "$D/node_modules"
ln -s "$ROOT/packages/cli" "$D/node_modules/vetkit"
printf "import { demoJudge } from 'vetkit';\nexport default { judge: demoJudge };\n" >"$D/vetkit.config.ts"
cd "$D" || exit 1
run run --gate
expect "gate: demo judge, run --gate" 2
assert "gate: the demo refusal says it is never gateable" 'grep -qF "demo judge is never gateable" "$ERR"'
run run
expect "gate: demo judge, plain run" 0
assert "gate: the demo run still prints gate: uncalibrated" 'grep -q "^gate: uncalibrated" "$OUT"'
run validate --json
expect "gate: demo judge, validate --json" 2
assert "gate: validate names GATE_REFUSED on stdout" 'grep -qF GATE_REFUSED "$OUT"'
assert "gate: validate wrote no criteria.lock.json" '[ ! -e criteria.lock.json ]'

# A calibrated lock for the fixture judge in pass mode.
L="$(fresh)"
cd "$L" || exit 1
jq -n '{
  lockVersion: 1,
  model: { requested: "fake-jev-pass", resolved: "fake-jev-pass-resolved", transport: "fake", pinned: false },
  criteria: { tone: {
    wordingHash: ("a" * 64), status: "calibrated", threshold: 0.5, tolerance: 0,
    gauntlet: { paraphrase: "pass", polarity: "pass", injection: "pass", master_key: "pass",
      label_permutation: "pass", constant_output: "pass", position_swap: "pass", length: "pass" },
    reasons: [], labelCount: 120 } },
  datasetHash: ("d" * 64)
}' >criteria.lock.json
run run --gate --allow-unpinned --json
expect "gate: run --gate --allow-unpinned against a calibrated lock" 0
assert "gate: the gate is calibrated for 1 criterion" \
  "jq -e '.gate.tier == \"calibrated\" and .gate.calibratedCriteria == 1' '$OUT'"
jq '.model.resolved = "someone-else"' criteria.lock.json >lock.tmp && mv lock.tmp criteria.lock.json
run run --gate --allow-unpinned
expect "gate: run --gate after the lock names another served model" 2
assert "gate: the refusal names both served models" \
  'grep -qF "served model '"'"'fake-jev-pass-resolved'"'"' differs from the lock'"'"'s '"'"'someone-else'"'"'" "$ERR"'

# --repeat, the response cache and the diag request counter.
R3="$(fresh)"
cd "$R3" || exit 1
CASES="$(wc -l <evals/cases/cases.jsonl | tr -d ' ')"
CRITERIA="$(grep -c '^  - id:' evals/criteria.yaml)"
diag_requests() { grep '^{"diag"' "$ERR" | jq -s '[.[].diag.judge.requests] | add'; }
CEV_DIAG=1 run run --repeat 3 --json
expect "gate: run --repeat 3 --json" 0
assert "gate: repeats is 3 and there is one verdict per repeat, case and criterion" \
  "jq -e '.repeats == 3 and (.results | length) == 3 * $CASES * $CRITERIA' '$OUT'"
assert "gate: a cold run makes 3 judge requests per case" '[ "$(diag_requests)" -eq $((3 * CASES)) ]'
assert "gate: the deterministic fixture judge has zero spread and no flaky cases" \
  "jq -e '.summary.flaky == 0 and ([.summary.byCase[].spread] | all(. == 0))' '$OUT'"
CEV_DIAG=1 run run --repeat 3 --json
expect "gate: the identical second run" 0
assert "gate: the second run makes no judge requests" '[ "$(diag_requests)" -eq 0 ]'
assert "gate: every second-run verdict is a cache hit" "jq -e '[.results[].cacheHit] | all' '$OUT'"

# Record with the fixture judge, replay with no judge, no key and an unreachable endpoint.
RC="$(fresh)"
cd "$RC" || exit 1
REC="$GATE/rec"
run run --record "$REC" --json
expect "gate: run --record" 0
cp "$OUT" "$GATE/recorded.json"
assert "gate: manifest.json has recordVersion 1" "jq -e '.recordVersion == 1' '$REC/manifest.json'"
assert "gate: an answer file named by its 64-hex key holds exactly answers, usage and model" \
  'f="$(ls "$REC" | grep -E "^[0-9a-f]{64}\.json$" | head -1)"; [ -n "$f" ] && jq -e "(keys | sort) == [\"answers\",\"model\",\"usage\"]" "$REC/$f"'
RP="$(fresh)"
cp "$ROOT/fixtures/projects/j3/vetkit.config.ts" "$RP/vetkit.config.ts"
cd "$RP" || exit 1
CEV_JUDGE_BASE_URL=http://127.0.0.1:9 CEV_DIAG=1 run run --replay "$REC" --json
expect "gate: run --replay with a typesafe-compatible config, no key, unreachable endpoint" 0
assert "gate: replayed results equal the recorded ones apart from cacheHit" \
  "diff <(jq -S '[.results[] | del(.cacheHit)]' '$GATE/recorded.json') <(jq -S '[.results[] | del(.cacheHit)]' '$OUT')"
assert "gate: replay made no judge request" '[ "$(diag_requests)" -eq 0 ]'
assert "gate: the recording does not contain the fixture key" '! grep -rF -- "$VETKIT_FIXTURE_KEY" "$REC"'
run run --record a --replay b
expect "gate: --record with --replay" 2

# 100 labelled cases: the cost estimate comes before the first judged case.
V="$(fresh)"
cd "$V" || exit 1
mkdir -p evals/labels
for i in $(seq 1 100); do
  printf '{"id":"c%s","input":{"state":"S-%s"},"provenance":null,"tags":[]}\n' "$i" "$i"
done >evals/cases/cases.jsonl
{
  echo 'case_id,criterion_id,label,labeler,labeled_at'
  for i in $(seq 1 100); do
    label=pass
    [ $((i % 2)) -eq 0 ] && label=fail
    echo "c$i,tone,$label,tester,2026-09-28T00:00:00Z"
  done
} >evals/labels/tone.csv
run validate
expect "gate: validate with 100 labelled cases" 0
assert "gate: the estimate line precedes the first case progress line" \
  'e="$(grep -n "estimate: " "$ERR" | head -1 | cut -d: -f1)"; c="$(grep -n "case c" "$ERR" | head -1 | cut -d: -f1)"; [ -n "$e" ] && [ -n "$c" ] && [ "$e" -lt "$c" ]'
run validate --json
expect "gate: validate --json" 0
assert "gate: the estimate is 300 calls" "jq -e '.estimate.calls == 300' '$OUT'"

# vet init writes the label template and a documented generator block.
I="$GATE/init"
mkdir -p "$I/node_modules"
ln -s "$ROOT/packages/cli" "$I/node_modules/vetkit"
cd "$I" || exit 1
run init --json
expect "gate: init --json in an empty directory" 0
assert "gate: init lists evals/labels.csv.example" "jq -e '.files | index(\"evals/labels.csv.example\")' '$OUT'"
assert "gate: the label template starts with the header" \
  '[ "$(head -1 evals/labels.csv.example)" = "case_id,criterion_id,label,labeler,labeled_at" ]'
assert "gate: the config documents an openai-compatible generator" \
  'grep -qF "// generator:" vetkit.config.ts && grep -qF openai-compatible vetkit.config.ts'
run run
expect "gate: the scaffolded project runs offline" 0

cd "$ROOT" || exit 1
assert "gate: docs/ci-gate.md is tracked" '[ "$(git ls-files docs/ci-gate.md)" = "docs/ci-gate.md" ]'

# ---- ci -----------------------------------------------------------------------------------
say "section: ci"
CI="$BASE/ci"
mkdir -p "$CI/bin"
printf '#!/usr/bin/env bash\nexec node "%s" "$@"\n' "$BIN" >"$CI/bin/vet"
chmod 755 "$CI/bin/vet"
# The stub gh lists no existing comment and copies the POSTed body to $STUB_COMMENT. It always
# reads stdin to the end so the caller's write to it cannot hit a closed pipe.
cat >"$CI/bin/gh" <<'GH'
#!/usr/bin/env bash
case "$*" in
  *"-X POST"*) cat >"$STUB_COMMENT" ;;
  *) cat >/dev/null ;;
esac
exit 0
GH
chmod 755 "$CI/bin/gh"
export PATH="$CI/bin:$PATH"
export GITHUB_ACTIONS=true NO_COLOR=1
export VETKIT_FIXTURE_KEY=sk-fake-smoke-0123456789abcdef
export GITHUB_STEP_SUMMARY="$CI/summary.md" GITHUB_OUTPUT="$CI/out.txt" GITHUB_ENV="$CI/env.txt" GITHUB_PATH="$CI/path.txt"
export STUB_COMMENT="$CI/comment.json"
printf '{"pull_request":{"number":7}}' >"$CI/event.json"

ci_reset() { : >"$GITHUB_STEP_SUMMARY"; : >"$GITHUB_OUTPUT"; : >"$GITHUB_ENV"; : >"$GITHUB_PATH"; rm -f "$STUB_COMMENT"; }

ci_project() { # <dir> <mode>: a fresh project copy
  rm -rf "$1"
  mkdir -p "$1"
  cp -r "$ROOT/fixtures/cli/run/." "$1"
  export GITHUB_WORKSPACE="$1" VETKIT_FIXTURE_MODE="$2"
  cd "$1" || exit 1
  ci_reset
}

# One action run plus its comment, as steps 4 to 6 of the journey.
ci_journey() { # <label> <mode> <expected exit> <headline>
  local label="$1" mode="$2" want="$3" headline="$4" dir="$CI/project-$2" code
  ci_project "$dir" "$mode"
  INPUT_CONFIG= INPUT_GATE=false INPUT_ALLOW_UNPINNED=false bash "$ROOT/action/run.sh" run 2>"$CI/stderr-$mode.txt" >/dev/null
  code=$?
  result "ci: $label run.sh run exits 0 whatever vet returns" 0 "$code" "$code"
  assert "ci: $label outputs carry exitCode=$want and a version" \
    "grep -qx 'exitCode=$want' '$GITHUB_OUTPUT' && grep -q '^version=' '$GITHUB_OUTPUT'"
  if [ "$mode" = fail ]; then
    assert "ci: $label outputs count 1 failed and 0 passed" "grep -qx 'failed=1' '$GITHUB_OUTPUT' && grep -qx 'passed=0' '$GITHUB_OUTPUT'"
    assert "ci: $label stderr has the ::error annotation for case-1" \
      "grep -q '^::error title=vetkit::case-1 failed' '$CI/stderr-$mode.txt'"
  else
    assert "ci: $label outputs count 1 passed and 0 failed" "grep -qx 'passed=1' '$GITHUB_OUTPUT' && grep -qx 'failed=0' '$GITHUB_OUTPUT'"
    assert "ci: $label stderr has no ::error annotation" "! grep -q '^::error' '$CI/stderr-$mode.txt'"
  fi
  assert "ci: $label job summary is non-empty, says uncalibrated and has no key" \
    "[ -s '$GITHUB_STEP_SUMMARY' ] && grep -qF uncalibrated '$GITHUB_STEP_SUMMARY' && ! grep -qF sk-fake-smoke '$GITHUB_STEP_SUMMARY'"
  assert "ci: $label latest.json and vet-junit.xml exist" '[ -s .vet/runs/latest.json ] && [ -s vet-junit.xml ]'

  GITHUB_EVENT_NAME=pull_request GITHUB_EVENT_PATH="$CI/event.json" GITHUB_REPOSITORY=MelsovCOZY/vetkit \
    GITHUB_SERVER_URL=https://github.com GITHUB_RUN_ID=424242 ARTIFACT_URL=https://example.invalid/artifact \
    REPORT_MD=.vet/report.md COMMENT_ID=smoke \
    node "$ROOT/action/comment.mjs" comment .vet/runs/latest.json .vet/baseline/latest.json >/dev/null 2>&1
  code=$?
  result "ci: $label comment.mjs posts through the stub gh" 0 "$code" "$code"
  jq -r .body "$STUB_COMMENT" >"$CI/body-$mode.txt" 2>/dev/null
  assert "ci: $label comment body starts with the sticky marker" \
    "[ \"\$(head -1 '$CI/body-$mode.txt')\" = '<!-- vetkit-report:smoke -->' ]"
  for needle in "$headline" 'thresholds uncalibrated: run vet validate' 'pinned: false —' 'actions/runs/424242' \
    'https://example.invalid/artifact'; do
    assert "ci: $label comment contains '$needle'" 'grep -qF -- "$needle" "$CI/body-$mode.txt"'
  done
  assert "ci: $label comment has no key" '! grep -qF sk-fake-smoke "$CI/body-$mode.txt"'
}

# install: no project vet, then a project vet.
ci_project "$CI/project-install" fail
INPUT_TARBALLS= INPUT_VERSION= bash "$ROOT/action/run.sh" install >"$OUT" 2>"$ERR"
CODE=$?
expect "ci: install without a project vet" 1
assert "ci: the install error names the missing project install" \
  'grep -qF "::error title=vetkit::vetkit is not installed in this project" "$ERR"'
mkdir -p node_modules/.bin
printf '#!/usr/bin/env bash\nexec node "%s" "$@"\n' "$BIN" >node_modules/.bin/vet
chmod 755 node_modules/.bin/vet
INPUT_TARBALLS= INPUT_VERSION= bash "$ROOT/action/run.sh" install >"$OUT" 2>"$ERR"
CODE=$?
expect "ci: install with a project vet" 0
assert "ci: install prints the project version line" 'grep -Eq "^vetkit [0-9]+\.[0-9]+\.[0-9]+ \(project\)$" "$OUT"'
assert "ci: install records the project mode" 'grep -qF VETKIT_INSTALL_MODE=project "$GITHUB_ENV"'

ci_journey "fail mode:" fail 1 '### vetkit: failed'
ci_journey "pass mode:" pass 0 '### vetkit: passed'

cd "$ROOT" || exit 1
unset CEV_E2E
bun x vitest run scripts/workflows-pinned.test.ts scripts/action-yml.test.ts scripts/action-readme.test.ts \
  scripts/release.test.ts scripts/action-selftest.test.ts >"$BASE/vitest.log" 2>&1
CODE=$?
result "ci: workflow and action static tests" 0 "$CODE" "$CODE" "log: $BASE/vitest.log"
node --test action/run.test.mjs action/comment.test.mjs >"$BASE/node-test.log" 2>&1
CODE=$?
result "ci: action script unit tests" 0 "$CODE" "$CODE" "log: $BASE/node-test.log"

finish
