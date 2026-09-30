#!/usr/bin/env bash
# First-run gate smoke: ONE keyless pass over the whole first-run journey.
#
# Sections (one scratch root, one build, one fake HTTP judge process at a time):
#   onboard  packed tarballs -> npm install -> init -> demo verdicts (no key, no network
#            beyond npm resolving the registry deps of the local tarballs)
#   judge    a key in .env reaches a fake typesafe-compatible HTTP judge
#            (fixtures/cli/judge-http/server.mjs), doctor attributes every value
#   config   walk-up discovery, cache, flat layout, --config, JSON config, help, docs
#   errors   every failure names the next step
#
# Tarballs: the packed @vetkit/* packages are not published, so every tarball is installed
# with npm `overrides` (scripts/consumer-matrix.sh write_consumer_manifest pattern) instead
# of `npm i -D <vetkit tgz>` alone.
#
# Prerequisite: `bun run build && bun run pack`. Every judge credential is unset below; the
# only network is `npm install` resolving registry dependencies.
#
# Usage: bash scripts/smoke-first-run.sh   (env: VETKIT_SMOKE_DIR to choose and keep the scratch root)
set -u

ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
BIN="$ROOT/packages/cli/dist/bin.js"
TARBALLS="$ROOT/dist-tarballs"
FAKE_JUDGE="$ROOT/fixtures/cli/judge-http/server.mjs"
FAILED=0

# Every judge credential (and CI, which changes prompting) is removed for the whole script.
CREDS=(AI_GATEWAY_API_KEY OPENROUTER_API_KEY CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID TYPESAFE_API_KEY CEV_JUDGE_BASE_URL CI CEV_E2E)
for name in "${CREDS[@]}"; do unset "$name"; done
export NO_COLOR=1

say() { printf 'smoke-first-run: %s\n' "$*"; }
result() { # <label> <expected> <observed-exit> <ok 0|1> [detail]
  local status=PASS
  if [ "$4" -ne 0 ]; then status=FAIL; FAILED=1; fi
  say "$status $1 (exit $3, expected $2)${5:+ — $5}"
}
# exit_is <label> <expected> <observed>: pass when the exit code matches.
exit_is() { result "$1" "$2" "$3" "$([ "$3" -eq "$2" ] && echo 0 || echo 1)"; }
# holds <label> <cmd...>: pass when the command exits 0 (an assertion on captured output).
holds() {
  local label="$1"
  shift
  "$@" >/dev/null 2>&1
  local code=$?
  result "$label" 0 "$code" "$code"
}

WORK="${VETKIT_SMOKE_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/vetkit-first-run.XXXXXX")}"
case "$WORK" in "$ROOT"|"$ROOT"/*) say "scratch dir must be outside the repo: $WORK" >&2; exit 2 ;; esac
CANARY="vetkit-smoke-canary"
FAKE_PID=""
FAKE_LOG=""
cleanup() { [ -n "$FAKE_PID" ] && kill "$FAKE_PID" 2>/dev/null; return 0; }
# On exit, pass or fail: stop the fake judge, then remove the scratch root when this script
# made it. A directory the caller named with VETKIT_SMOKE_DIR is the caller's to keep.
on_exit() { cleanup; [ -z "${VETKIT_SMOKE_DIR:-}" ] && rm -rf "$WORK"; return 0; }
trap on_exit EXIT

command -v jq >/dev/null || { say "jq is required" >&2; exit 2; }
[ -f "$BIN" ] || { say "missing $BIN: run bun run build first" >&2; exit 2; }
ls "$TARBALLS"/*.tgz >/dev/null 2>&1 || { say "no tarballs in $TARBALLS: run bun run pack first" >&2; exit 2; }

rm -rf "$WORK"
mkdir -p "$WORK"
say "scratch $WORK"

start_fake() { # <args...>: starts the fake judge, sets FAKE (url) and FAKE_PID
  cleanup
  FAKE_LOG="$WORK/fake-judge.log"
  : >"$FAKE_LOG"
  node "$FAKE_JUDGE" --port 0 "$@" >"$FAKE_LOG" 2>&1 &
  FAKE_PID=$!
  local i
  for i in $(seq 1 100); do
    if grep -q '^listening ' "$FAKE_LOG"; then break; fi
    sleep 0.1
  done
  FAKE="$(sed -n 's/^listening //p' "$FAKE_LOG" | head -1)"
}
fake_requests() { grep -c '^auth ' "$FAKE_LOG"; }

# ---------------------------------------------------------------- section: onboard
say "== onboard: packed tarballs, keyless first verdict"
OB="$WORK/onboard"
mkdir -p "$OB"
cd "$OB" || exit 1
node -e '
  const fs = require("node:fs");
  const path = require("node:path");
  const { execFileSync } = require("node:child_process");
  const dir = process.argv[1];
  const deps = {};
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".tgz")).sort()) {
    const tgz = path.join(dir, file);
    const pkg = JSON.parse(execFileSync("tar", ["-xzOf", tgz, "package/package.json"], { encoding: "utf8" }));
    deps[pkg.name] = `file:${tgz}`;
  }
  const manifest = { name: "first-run-consumer", private: true, type: "module", dependencies: deps, overrides: deps };
  fs.writeFileSync("package.json", JSON.stringify(manifest, null, 2));
' "$TARBALLS"
npm install --no-audit --no-fund >install.out 2>&1
exit_is "onboard 1: npm install of the packed tarballs" 0 $?

npx vetkit --version >v1.out 2>v1.err
c1=$?
npx vet --version >v2.out 2>v2.err
c2=$?
WANT="$(tar -xzOf "$TARBALLS/vetkit-0.0.0.tgz" package/package.json 2>/dev/null | jq -r .version)"
[ -n "$WANT" ] || WANT="$(for f in "$TARBALLS"/vetkit-[0-9]*.tgz; do tar -xzOf "$f" package/package.json | jq -r .version; done | head -1)"
ok=1
[ "$c1" -eq 0 ] && [ "$c2" -eq 0 ] && cmp -s v1.out v2.out && [ "$(cat v1.out)" = "$WANT" ] && ok=0
result "onboard 2: vetkit --version == vet --version == tarball version ($WANT)" 0 "$c1/$c2" "$ok"

CANARY_ENV=(env "VETKIT_FIXTURE_KEY=$CANARY")
"${CANARY_ENV[@]}" npx vetkit init >init.out 2>init.err
code=$?
exit_is "onboard 3a: vetkit init" 0 "$code"
ok=0
for f in 'wrote vetkit.config.ts' 'wrote evals/criteria.yaml' 'wrote evals/cases/example.jsonl' 'wrote .gitignore'; do
  grep -qF "$f" init.out || ok=1
done
result "onboard 3b: init stdout lists the written files" 0 0 "$ok"
holds "onboard 3c: config imports from 'vetkit'" grep -q "from 'vetkit'" vetkit.config.ts
holds "onboard 3d: config uses defineConfig(" grep -q 'defineConfig(' vetkit.config.ts
holds "onboard 3e: config uses demoJudge" grep -q 'demoJudge' vetkit.config.ts
# No live apiKeyEnv: comment lines (the commented generator example) do not count.
result "onboard 3f: config sets no apiKeyEnv outside comments" 0 0 "$(grep -v '^[[:space:]]*//' vetkit.config.ts | grep -q apiKeyEnv && echo 1 || echo 0)"
result "onboard 3g: criteria.yaml starts with the schema modeline" 0 0 \
  "$([ "$(head -1 evals/criteria.yaml)" = '# yaml-language-server: $schema=https://melsovcozy.github.io/vetkit/schemas/criteria.schema.json' ] && echo 0 || echo 1)"
holds "onboard 3h: criteria.yaml has a \$schema key" grep -q '^\$schema:' evals/criteria.yaml
result "onboard 3i: example.jsonl has 3 cases" 0 0 "$([ "$(wc -l <evals/cases/example.jsonl | tr -d ' ')" = 3 ] && echo 0 || echo 1)"
result "onboard 3j: no should-fail case" 0 0 "$([ "$(grep -c should-fail evals/cases/example.jsonl)" = 0 ] && echo 0 || echo 1)"

"${CANARY_ENV[@]}" npx vetkit run >run.out 2>run.err
code=$?
exit_is "onboard 4a: vetkit run" 0 "$code"
holds "onboard 4b: 3 passed, 0 failed, 0 unscored of 3" grep -qF '3 passed, 0 failed, 0 unscored of 3' run.out
holds "onboard 4c: model line names the demo judge" grep -qF 'model: demo (transport demo, pinned: false)' run.out
ok=1
if [ "$(grep -c '^warn demo judge:' run.err)" = 1 ]; then
  line="$(grep '^warn demo judge:' run.err)"
  ok=0
  for needle in .env 'vet init --force' AI_GATEWAY_API_KEY OPENROUTER_API_KEY CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID TYPESAFE_API_KEY; do
    case "$line" in *"$needle"*) ;; *) ok=1 ;; esac
  done
fi
result "onboard 4d: one 'warn demo judge:' line naming .env, init --force and every credential" 0 0 "$ok"
result "onboard 4e: no .vet/cache entries" 0 0 "$([ "$(ls .vet/cache 2>/dev/null | wc -l | tr -d ' ')" = 0 ] && echo 0 || echo 1)"

"${CANARY_ENV[@]}" npx vetkit run --json >runj.out 2>runj.err
code=$?
exit_is "onboard 5a: vetkit run --json" 0 "$code"
holds "onboard 5b: json says demo, unpinned, exit 0, none failed, no cache hits" \
  jq -e '.model.transport=="demo" and .model.pinned==false and .exitCode==0 and .summary.failed==0 and all(.results[]; .model.transport=="demo" and .cacheHit==false)' runj.out
result "onboard 5c: --json stdout is exactly one line" 0 0 "$([ "$(wc -l <runj.out | tr -d ' ')" = 1 ] && echo 0 || echo 1)"
holds "onboard 5d: .vet/runs/latest.json records the demo transport" jq -e '.model.transport=="demo"' .vet/runs/latest.json

"${CANARY_ENV[@]}" npx vetkit run --gate >gate.out 2>gate.err
exit_is "onboard 6: vetkit run --gate (message text is not asserted)" 2 $?

# Nothing may echo the unrelated env value anywhere in the scratch project (node_modules
# excluded: it is npm's output, not something vetkit wrote).
hits="$(grep -rl "$CANARY" . --exclude-dir=node_modules 2>/dev/null | wc -l | tr -d ' ')"
result "onboard 7: no writer echoed VETKIT_FIXTURE_KEY ($hits files)" 0 0 "$([ "$hits" = 0 ] && echo 0 || echo 1)"
cd "$ROOT" || exit 1

# ---------------------------------------------------------------- section: judge
say "== judge: a key in .env reaches the fake HTTP judge"
JC="hyphen-canary-0a1b2c3d-4e5f6a7b-8c9d0e1f-2a3b"
JD="$WORK/judge"
mkdir -p "$JD"
cd "$JD" || exit 1
# A consumer project needs `vetkit` resolvable from the config; reuse the onboard install.
ln -s "$OB/node_modules" node_modules
vet() { node "$BIN" "$@" </dev/null; }

start_fake --key "$JC" --served-model fake/jev-served
holds "judge 1: fake judge printed listening <url>" test -n "$FAKE"

printf 'OPENROUTER_API_KEY=%s\n' "$JC" >.env
vet init >init.out 2>init.err
code=$?
exit_is "judge 2a: vet init with a key in .env" 0 "$code"
result "judge 2b: config uses preset 'openrouter'" 1 "$(grep -c "preset: 'openrouter'" vetkit.config.ts)" "$([ "$(grep -c "preset: 'openrouter'" vetkit.config.ts)" = 1 ] && echo 0 || echo 1)"
result "judge 2c: config has no allowUnpinned" 0 "$(grep -c allowUnpinned vetkit.config.ts)" "$([ "$(grep -c allowUnpinned vetkit.config.ts)" = 0 ] && echo 0 || echo 1)"
result "judge 2d: init stderr carries no canary" 0 0 "$(grep -qF "$JC" init.err init.out && echo 1 || echo 0)"

CEV_JUDGE_BASE_URL="$FAKE" vet run --json >run1.json 2>run1.err
code=$?
exit_is "judge 3a: vet run --json against the fake judge" 0 "$code"
result "judge 3b: every verdict records the served model id" 0 0 \
  "$([ "$(jq -r '.results[].model.resolved' run1.json | sort -u)" = fake/jev-served ] && echo 0 || echo 1)"
result "judge 3c: every verdict is pinned: true" 0 0 \
  "$([ "$(jq -r '.results[].model.pinned' run1.json | sort -u)" = true ] && echo 0 || echo 1)"
reqs="$(fake_requests)"
result "judge 3d: every request carried the Bearer key ($reqs requests, all auth ok)" 0 0 \
  "$([ "$reqs" -ge 1 ] && ! grep -q '^auth fail' "$FAKE_LOG" && echo 0 || echo 1)"

CEV_JUDGE_BASE_URL="$FAKE" vet doctor --json >doc1.json 2>doc1.err
code=$?
exit_is "judge 4a: vet doctor --json" 0 "$code"
result "judge 4b: key value source is .env" 0 0 \
  "$([ "$(jq -r '.values[] | select(.name=="key value") | .source' doc1.json)" = .env ] && echo 0 || echo 1)"
result "judge 4c: transport is openrouter from config" 0 0 \
  "$([ "$(jq -r '.values[] | select(.name=="transport") | .value+" "+.source' doc1.json)" = 'openrouter config' ] && echo 0 || echo 1)"
result "judge 4d: baseURL source is env" 0 0 \
  "$([ "$(jq -r '.values[] | select(.name=="baseURL") | .source' doc1.json)" = env ] && echo 0 || echo 1)"
result "judge 4e: judge endpoint health passes" 0 0 \
  "$([ "$(jq -r '.checks[] | select(.name=="judge endpoint health") | .status' doc1.json)" = pass ] && echo 0 || echo 1)"
result "judge 4f: doctor names no bun or lefthook check" 0 0 \
  "$(jq -r '.checks[].name' doc1.json | grep -qE 'bun|lefthook' && echo 1 || echo 0)"

OPENROUTER_API_KEY=wrong-key-0000000000000000000000000000 CEV_JUDGE_BASE_URL="$FAKE" vet doctor --json >doc2.json 2>doc2.err
code=$?
exit_is "judge 5a: doctor with a wrong process-env key" 1 "$code"
result "judge 5b: health row is fail" 0 0 \
  "$([ "$(jq -r '.checks[] | select(.name=="judge endpoint health") | .status' doc2.json)" = fail ] && echo 0 || echo 1)"
result "judge 5c: key value source is env (process env beats .env)" 0 0 \
  "$([ "$(jq -r '.values[] | select(.name=="key value") | .source' doc2.json)" = env ] && echo 0 || echo 1)"

CEV_JUDGE_BASE_URL="$FAKE" vet run --no-env-file --json >run2.json 2>run2.err
code=$?
exit_is "judge 6a: vet run --no-env-file with no process key" 2 "$code"
# With --json the error document is written to stdout (run2.json); stderr may be empty.
holds "judge 6b: the error names OPENROUTER_API_KEY" grep -q OPENROUTER_API_KEY run2.err run2.json
result "judge 6c: stderr carries no canary" 0 0 "$(grep -qF "$JC" run2.err run2.json && echo 1 || echo 0)"

rm -rf .vet
start_fake --key "$JC" --served-model fake/jev-served --throttle-once 'retry-after=1'
t0=$(date +%s%N)
CEV_JUDGE_BASE_URL="$FAKE" vet run --json --verbose >run3.json 2>run3.err
code=$?
elapsed_ms=$(((($(date +%s%N)) - t0) / 1000000))
exit_is "judge 7a: throttled once, then served" 0 "$code"
result "judge 7b: exactly one JUDGE_THROTTLED line" 1 "$(grep -c JUDGE_THROTTLED run3.err)" "$([ "$(grep -c JUDGE_THROTTLED run3.err)" = 1 ] && echo 0 || echo 1)"
result "judge 7c: that line has retryAfterMs 1000" 0 0 "$(grep JUDGE_THROTTLED run3.err | grep -q '"retryAfterMs":1000' && echo 0 || echo 1)" "$(grep JUDGE_THROTTLED run3.err | head -1)"
result "judge 7d: wall time >= 1 s (${elapsed_ms} ms)" 0 0 "$([ "$elapsed_ms" -ge 1000 ] && echo 0 || echo 1)"

# Fallback refusal: vercel preset with a gateway model fallback must refuse before any request.
sed -e "s/preset: 'openrouter'/preset: 'vercel'/" -e "s/apiKeyEnv: 'OPENROUTER_API_KEY',/apiKeyEnv: 'OPENROUTER_API_KEY',\n    providerOptions: { gateway: { zeroDataRetention: true, only: ['typesafe-ai'], models: ['other\/model'] } },/" \
  vetkit.config.ts >vetkit.vercel-fallback.config.ts
before="$(fake_requests)"
CEV_JUDGE_BASE_URL="$FAKE" vet run --config vetkit.vercel-fallback.config.ts --json >run4.json 2>run4.err
code=$?
after="$(fake_requests)"
exit_is "judge 8a: vercel config with a model fallback is refused" 2 "$code"
holds "judge 8b: the error mentions fallback" grep -qi fallback run4.err run4.json
result "judge 8c: the fake judge saw 0 requests during the refusal" 0 0 "$([ "$before" = "$after" ] && echo 0 || echo 1)" "$before -> $after"

cleanup
FAKE_PID=""
hits="$(grep -rF "$JC" . 2>/dev/null | grep -vF './.env:' | wc -l | tr -d ' ')"
result "judge 9: the canary appears nowhere in the scratch dir but .env ($hits hits)" 0 0 "$([ "$hits" = 0 ] && echo 0 || echo 1)"
cd "$ROOT" || exit 1

# ---------------------------------------------------------------- section: config
say "== config: any directory, any layout, cache, help, docs"
P="$WORK/config"
mkdir -p "$P"
cp -r "$ROOT/fixtures/cli/run/." "$P/"
mkdir -p "$P/node_modules"
ln -s "$ROOT/packages/cli" "$P/node_modules/vetkit"
# The fixture judge imports node:fs and reads process.env, so tsc needs @types/node (the
# gate's `types: []` would reject those lines of the fixture itself).
mkdir -p "$P/node_modules/@types"
ln -s "$ROOT/node_modules/@types/node" "$P/node_modules/@types/node"
sed -i "s|^export default { judge };|import { defineConfig } from 'vetkit';\nexport default defineConfig({ judge, thresholds: { default: 0.5 } });|" "$P/vetkit.config.ts"
# A consumer project is an ES module package; node16 resolution needs that to import 'vetkit'.
printf '{"name":"config-project","private":true,"type":"module"}' >"$P/package.json"
cat >"$P/tsconfig.json" <<'JSON'
{"compilerOptions":{"module":"node16","moduleResolution":"node16","strict":true,"exactOptionalPropertyTypes":true,"noEmit":true,"skipLibCheck":false,"types":["node"]},"files":["vetkit.config.ts"]}
JSON
export VETKIT_FIXTURE_MODE=pass
vk() { node "$BIN" "$@" </dev/null; }

cd "$P" || exit 1
(cd "$ROOT" && bun x tsc -p "$P/tsconfig.json") >tsc.out 2>&1
code=$?
result "config 2: defineConfig from 'vetkit' type-checks" 0 "$code" "$code" "$(head -3 tsc.out | tr '\n' ' ')"

mkdir -p sub
(cd sub && vk run --json >../sub.json 2>../sub.err)
code=$?
exit_is "config 3a: run --json from a subdirectory (walk-up discovery)" 0 "$code"
holds "config 3b: every result is a cache miss" jq -e '(.results|length)>=1 and all(.results[]; .cacheHit==false)' sub.json

vk run >pretty.out 2>pretty.err
exit_is "config 4a: second pretty run" 0 $?
holds "config 4b: cache: 1 cached, 0 judged" grep -qF 'cache: 1 cached, 0 judged' pretty.out

vk run --no-cache >nocache.out 2>nocache.err
exit_is "config 5a: run --no-cache" 0 $?
holds "config 5b: cache: 0 cached, 1 judged" grep -qF 'cache: 0 cached, 1 judged' nocache.out

ENTRY="$(ls .vet/*.json 2>/dev/null | head -1)"
printf '{' >"$ENTRY"
vk run >corrupt.out 2>corrupt.err
exit_is "config 6a: run over a corrupt cache entry" 0 $?
result "config 6b: stderr has exactly one CACHE_CORRUPT re-judge line" 1 "$(grep -c 'is corrupt; re-judging \[CACHE_CORRUPT\]' corrupt.err)" "$([ "$(grep -c 'is corrupt; re-judging \[CACHE_CORRUPT\]' corrupt.err)" = 1 ] && echo 0 || echo 1)"
holds "config 6c: cache: 0 cached, 1 judged" grep -qF 'cache: 0 cached, 1 judged' corrupt.out
holds "config 6d: the entry file is valid JSON again" jq -e . "$ENTRY"

vk cache clear --json >clear.out 2>clear.err
exit_is "config 7a: cache clear --json" 0 $?
result "config 7b: cleared 1 from \$P/.vet" 0 0 "$([ "$(cat clear.out)" = "{\"cleared\":1,\"dir\":\"$P/.vet\"}" ] && echo 0 || echo 1)" "$(cat clear.out)"
holds "config 7c: runs/latest.json survives the clear" test -f .vet/runs/latest.json
vk cache clear >clear2.out 2>clear2.err
exit_is "config 7d: second cache clear" 0 $?
result "config 7e: says cleared 0 cache entries" 0 0 "$([ "$(cat clear2.out)" = "cleared 0 cache entries from $P/.vet" ] && echo 0 || echo 1)" "$(cat clear2.out)"

mkdir -p flat
cp vetkit.config.ts flat/
cp evals/criteria.yaml flat/criteria.yaml
cp -r evals/cases flat/cases
(cd flat && vk run >../flat-run.out 2>../flat-run.err)
exit_is "config 8a: flat layout run" 0 $?
(cd flat && vk estimate >../flat-est.out 2>../flat-est.err)
exit_is "config 8b: flat layout estimate" 0 $?
holds "config 8c: estimate prints input tokens:" grep -qF 'input tokens:' flat-est.out
(cd flat && vk validate >../flat-val.out 2>../flat-val.err)
exit_is "config 8d: flat layout validate fails on labels" 2 $?
holds "config 8e: validate names LABELS_TOO_FEW" grep -q LABELS_TOO_FEW flat-val.err
result "config 8f: validate does not ENOENT (paths resolved)" 0 0 "$(grep -q ENOENT flat-val.err && echo 1 || echo 0)"

(cd "$WORK" && vk lint --config "$P/vetkit.config.ts" >"$P/lint.out" 2>"$P/lint.err")
exit_is "config 9a: lint --config from an unrelated directory" 0 $?
result "config 9b: lint says no issues" 0 0 "$([ "$(cat lint.out)" = 'no issues' ] && echo 0 || echo 1)" "$(head -1 lint.out)"
(cd "$WORK" && vk cases dedupe --config "$P/vetkit.config.ts" >"$P/dedupe.out" 2>"$P/dedupe.err")
exit_is "config 9c: cases dedupe --config" 0 $?
(cd "$WORK" && vk lock --config "$P/vetkit.config.ts" --help >"$P/lockhelp.out" 2>"$P/lockhelp.err")
exit_is "config 9d: lock --config --help" 0 $?

mkdir -p json
cp -r evals json/
printf '{"judge":{"kind":"typesafe-compatible","preset":"vercel","apiKeyEnv":"SMOKE_UNSET"}}' >json/vetkit.config.json
(cd json && vk estimate >../json-est.out 2>../json-est.err)
exit_is "config 10: JSON config, estimate needs no credential" 0 $?

vk rerun --help >rerun-help.out 2>&1
result "config 11a: rerun --help has no --disputed" 0 0 "$(grep -qF -- '--disputed' rerun-help.out && echo 1 || echo 0)"
vk cases --help >cases-help.out 2>&1
ok=0
for sub in dedupe quarantine promote review; do
  grep -qE "^ +$sub( +[^ ]+)*  +[a-z]" cases-help.out || { ok=1; say "  cases --help: no description after $sub"; }
done
result "config 11b: every cases subcommand has help text" 0 0 "$ok"

(cd "$ROOT" && env -u CEV_E2E bun x vitest run --project scripts scripts/docs-config.test.ts >"$P/vt-scripts.out" 2>&1)
exit_is "config 12a: docs freshness unit test" 0 $?
(cd "$ROOT" && env -u CEV_E2E bun x vitest run --project cli packages/cli/src/docs-flags.test.ts packages/cli/src/config-load.test.ts >"$P/vt-cli.out" 2>&1)
exit_is "config 12b: docs flags and Node-floor unit tests" 0 $?

for f in packages/spec/schemas/config.schema.json docs/configuration.md; do
  n="$(grep -c "'fenced-v1' when omitted" "$ROOT/$f")"
  result "config 13a: $f mentions the fenced-v1 default once" 1 "$n" "$([ "$n" = 1 ] && echo 0 || echo 1)"
done
n="$(grep -c 'not implemented yet' "$ROOT/docs/configuration.md")"
result "config 13b: docs/configuration.md has no 'not implemented yet'" 0 "$n" "$([ "$n" = 0 ] && echo 0 || echo 1)"
unset VETKIT_FIXTURE_MODE
cd "$ROOT" || exit 1

# ---------------------------------------------------------------- section: errors
say "== errors: every failure names the next step"
E="$WORK/errors"
OUT="$E/out"
mkdir -p "$E/empty" "$OUT"
mkdir -p "$E/project"
cp -r "$ROOT/fixtures/cli/run/." "$E/project/"
FIXTURE_SECRET="sk-smoke-do-not-print-4242"
export VETKIT_FIXTURE_KEY="$FIXTURE_SECRET"
# run_err <name> <dir> <mode> <args...>: captures $OUT/<name>.out|err, sets CODE.
run_err() {
  local name="$1" dir="$2" mode="$3"
  shift 3
  (cd "$dir" && VETKIT_FIXTURE_MODE="$mode" node "$BIN" "$@" </dev/null >"$OUT/$name.out" 2>"$OUT/$name.err")
  CODE=$?
}

run_err empty "$E/empty" pass run
exit_is "errors 1a: run with no config" 2 "$CODE"
first="$(sed -n 1p "$OUT/empty.err")"
case "$first" in
  'error CONFIG_INVALID:'*'run: vet init') ok=0 ;;
  *) ok=1 ;;
esac
result "errors 1b: stderr line 1 starts 'error CONFIG_INVALID:' and ends 'run: vet init'" 0 0 "$ok" "$first"
holds "errors 1c: stderr line 2 is the CONFIG_INVALID hint" sh -c "sed -n 2p '$OUT/empty.err' | grep -q ."

run_err down "$E/project" down run
exit_is "errors 2a: run with a dead judge" 3 "$CODE"
holds "errors 2b: stderr names [UNSCORED_ONLY]" grep -qF '[UNSCORED_ONLY]' "$OUT/down.err"
run_err downj "$E/project" down run --json
exit_is "errors 2c: run --json with a dead judge" 3 "$CODE"
holds "errors 2d: one JSON doc, exitCode 3, unscored == total" \
  jq -e '.exitCode==3 and .summary.unscored==.summary.total and .summary.total>=1' "$OUT/downj.out"

run_err thr "$E/project" throttled run
exit_is "errors 3a: run while throttled" 3 "$CODE"
result "errors 3b: exactly one 'judge throttled' summary line" 1 "$(grep -cE '^(warn )?judge throttled: [0-9]+ retries, waited [0-9]+ms \[JUDGE_THROTTLED\]$' "$OUT/thr.err")" \
  "$([ "$(grep -cE '^(warn )?judge throttled: [0-9]+ retries, waited [0-9]+ms \[JUDGE_THROTTLED\]$' "$OUT/thr.err")" = 1 ] && echo 0 || echo 1)"
result "errors 3c: zero [JUDGE_RETRY] lines without --verbose" 0 "$(grep -c '\[JUDGE_RETRY\]' "$OUT/thr.err")" \
  "$([ "$(grep -c '\[JUDGE_RETRY\]' "$OUT/thr.err")" = 0 ] && echo 0 || echo 1)"
run_err thrv "$E/project" throttled run --verbose
holds "errors 3d: --verbose prints at least one [JUDGE_RETRY] line" grep -qF '[JUDGE_RETRY]' "$OUT/thrv.err"

# Stderr lines carry a level prefix ('warn ', 'error ') and info/warn lines precede the
# failure, so "line 1" below means the first 'error ' line, with the prefix.
# Terminal auth/billing kinds need the judge request path to rethrow VetErrors with
# details.kind; probe the source the way the gate defines it.
if grep -q 'details?.kind' "$ROOT/packages/core/src/judge/request.ts"; then
  run_err unauth "$E/project" unauthorized run
  exit_is "errors 4a: run with a rejected key" 2 "$CODE"
  result "errors 4b: first error line is JUDGE_UNAUTHORIZED" 0 0 \
    "$([ "$(grep -m1 '^error ' "$OUT/unauth.err")" = 'error JUDGE_UNAUTHORIZED: judge rejected the API key' ] && echo 0 || echo 1)" "$(grep -m1 '^error ' "$OUT/unauth.err")"
  run_err unauthj "$E/project" unauthorized run --json
  holds "errors 4c: --json error kind is terminal-auth" jq -e '.error.code=="JUDGE_UNAUTHORIZED" and .error.kind=="terminal-auth"' "$OUT/unauthj.out"
  run_err nocred "$E/project" no-credit run
  exit_is "errors 4d: run with no judge credit" 2 "$CODE"
  result "errors 4e: first error line is JUDGE_UNAVAILABLE no credit" 0 0 \
    "$([ "$(grep -m1 '^error ' "$OUT/nocred.err")" = 'error JUDGE_UNAVAILABLE: judge account has no credit' ] && echo 0 || echo 1)" "$(grep -m1 '^error ' "$OUT/nocred.err")"
  run_err nocredj "$E/project" no-credit run --json
  holds "errors 4f: --json error kind is terminal-billing" jq -e '.error.kind=="terminal-billing"' "$OUT/nocredj.out"
else
  say "SKIP errors 4: unauthorized/no-credit (judge rethrow not landed: no details?.kind in packages/core/src/judge/request.ts)"
fi

cat >"$E/project/evals/criteria.yaml" <<'YAML'
criteria:
  - id: tone
    type: boolean
    instructions: Is the reply polite?
    escape: The reply has no discernible tone.
    polarity: pass_when_true
    channel: quality
    provenance:
      traceIds: []
  - id: helpful
    type: boolean
    instructions: Did the reply help?
    polarity: pass_when_true
    channel: quality
    provenance:
      traceIds: []
YAML
run_err lint "$E/project" pass lint evals/criteria.yaml
exit_is "errors 5a: lint a criterion with no escape" 2 "$CODE"
holds "errors 5b: lint stderr names /criteria/1/escape" grep -qF '/criteria/1/escape' "$OUT/lint.err"
run_err badrun "$E/project" pass run
exit_is "errors 5c: run on the same criteria file" 2 "$CODE"
holds "errors 5d: run stderr names /criteria/1/escape" grep -qF '/criteria/1/escape' "$OUT/badrun.err"

run_err help "$E/project" pass --help
exit_is "errors 6a: --help" 0 "$CODE"
holds "errors 6b: help documents exit code 3" grep -qE '^\s+3\s' "$OUT/help.out"
holds "errors 6c: help documents exit code 70" grep -qE '^\s+70\s' "$OUT/help.out"

run_err frob "$E/project" pass run --frobnicate
exit_is "errors 7: run --frobnicate is a usage error" 2 "$CODE"

result "errors forbidden 1: no output prints the fixture key" 0 0 "$(grep -rqF "$FIXTURE_SECRET" "$OUT" && echo 1 || echo 0)"
result "errors forbidden 2: no output contains the word 'body'" 0 0 "$(grep -rqiw body "$OUT" && echo 1 || echo 0)" "$(grep -rihw body "$OUT" | head -1)"
result "errors forbidden 3: no output mentions --strict" 0 0 "$(grep -rqF -- '--strict' "$OUT" && echo 1 || echo 0)"
unset VETKIT_FIXTURE_KEY

# ---------------------------------------------------------------- verdict
cd "$ROOT" || exit 1
if [ "$FAILED" -ne 0 ]; then
  if [ -n "${VETKIT_SMOKE_DIR:-}" ]; then
    say "FAILED (scratch kept at $WORK)"
  else
    say "FAILED (set VETKIT_SMOKE_DIR to keep the scratch dir)"
  fi
  exit 1
fi
say ok
