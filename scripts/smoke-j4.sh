#!/usr/bin/env bash
# J4 smoke: `vet export --to vitest` on the J4 seed,
# vitest runs the emitted files unchanged, parity with `vet run --json`, and a cached rerun with
# zero judge requests. Real Jev judge through the vercel preset.
#
# Live calls: N cases x 1 judge request in the `vet run` warm-up; the vitest runs hit the shared
# cache. The scratch project (under <repo>/.vet, gitignored, so `vetkit` and `vitest` resolve)
# is wiped at the start. Key: AI_GATEWAY_API_KEY from env, else VETKIT_ENV_FILE (default repo
# .env) via `bun --env-file`. The key and judge bodies are never printed.
#
# Usage: bash scripts/smoke-j4.sh
set -u

ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
PROJECT="${VETKIT_SMOKE_DIR:-$ROOT/.vet/smoke-j4}"
ENV_FILE="${VETKIT_ENV_FILE:-$ROOT/.env}"
BIN="$ROOT/packages/cli/dist/bin.js"
FAILED=0

say() { printf 'smoke-j4: %s\n' "$*"; }
result() { # <label> <observed-exit> <ok 0|1> [detail]
  local status=PASS
  if [ "$3" -ne 0 ]; then status=FAIL; FAILED=1; fi
  say "$status $1 (exit $2)${4:+ — $4}"
}

ENV_ARGS=()
if [ -z "${AI_GATEWAY_API_KEY:-}" ]; then
  if [ ! -f "$ENV_FILE" ]; then say "AI_GATEWAY_API_KEY unset and $ENV_FILE missing" >&2; exit 1; fi
  ENV_ARGS=("--env-file=$ENV_FILE")
fi
vet() { bun "${ENV_ARGS[@]}" "$BIN" "$@"; }
# vitest's workers need the key in the process env; bun --env-file does not reach them, node does.
vt() { node "${ENV_ARGS[@]}" "$ROOT/node_modules/vitest/vitest.mjs" "$@"; }

say "building"
(
  cd "$ROOT" || exit 1
  if [ ! -d node_modules ]; then bun install --frozen-lockfile >/dev/null || exit 1; fi
  bun run build >/dev/null
) || { say "build failed" >&2; exit 1; }

rm -rf "$PROJECT"
mkdir -p "$PROJECT/node_modules"
cp -r "$ROOT/fixtures/projects/j4/." "$PROJECT/"
ln -s "$ROOT/packages/cli" "$PROJECT/node_modules/vetkit"
cd "$PROJECT" || exit 1
say "project $PROJECT"

# Step 1: warm the verdict cache.
vet run --json >run.json 2>run.err
code=$?
jq -e '(.results|length) >= 3 and all(.results[]; .status=="ok")' run.json >/dev/null
result "step1: vet run --json (warm cache, >=3 ok verdicts)" "$code" "$?" \
  "$(jq -c '[.results[]|{caseId,pass,cacheHit}]' run.json 2>/dev/null)"
if [ "$FAILED" -ne 0 ]; then say "FAILED (judge did not score; later steps skipped)"; exit 1; fi
# A failing case makes `vet run` exit 1 by design; only the verdicts matter here.

# AC1: export writes the scorers and the test file (<criteria file>.evals.test.ts).
vet export --to vitest >export.out 2>export.err
code=$?
ls evals/vitest/scorers evals/vitest/*.test.ts >ls.out 2>&1
lsx=$?
[ "$code" -eq 0 ] && [ "$lsx" -eq 0 ] && [ -f evals/vitest/scorers/promised-refund.ts ] \
  && [ -f evals/vitest/criteria.yaml.evals.test.ts ]
result "AC1: vet export --to vitest; ls evals/vitest/scorers evals/vitest/*.test.ts" "$code" "$?" \
  "$(tr '\n' ' ' <ls.out)"

# AC2: vitest runs the emitted files unchanged; the diff script reports zero differences.
CEV_TRACE_HTTP=1 vt run --reporter=json --outputFile=vt.json evals/vitest >vt1.out 2>vt1.err
vcode=$?
node "$ROOT/scripts/diff-verdicts.mjs" run.json vt.json >diff.out 2>diff.err
code=$?
result "AC2: vitest run --reporter=json + diff-verdicts.mjs; echo \$?" "$code" \
  "$([ "$code" -eq 0 ] && grep -qx 'differences: 0' diff.out && echo 0 || echo 1)" \
  "vitest exit $vcode; $(cat diff.out) $(head -c 200 diff.err)"

# AC3: a second vitest run makes zero judge requests (cache shared with vet run).
CEV_TRACE_HTTP=1 vt run evals/vitest >vt2.out 2>vt2.err
code=$?
# A run that died on config/judge errors would print 0 requests too: reject VetError output.
grep -q 'judge.requests: 0' vt2.out vt2.err && ! grep -q 'VetError' vt2.out vt2.err
result "AC3: CEV_TRACE_HTTP=1 vitest run evals/vitest -> judge.requests: 0" "$code" "$?" \
  "$(grep -h 'judge.requests' vt2.out vt2.err | head -1)"

if [ "$FAILED" -ne 0 ]; then say "FAILED"; exit 1; fi
say "ok"
