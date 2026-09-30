#!/usr/bin/env bash
# Release-readiness smoke: ONE keyless pass over the publish and integrate journeys.
#
# Sections (one scratch root, one clone, one build, one pack):
#   build      clone HEAD, frozen install, build, pack: one tarball per package
#   tarballs   release-check, per-tarball license/readme/engines/repository, no source maps,
#              no retired host name, no span attribute leaking into the sink
#   consumer   every tarball installed with npm `overrides` (the packages are not published),
#              vetkit/vet binaries, migrate + run on the keyless fixture project, canary grep
#   site       the Pages tree is staged offline; schema ids and anchors are checked
#   metadata   repo-metadata.sh --dry-run with a gh shim that must record zero calls
#   units      the release-facing unit suites
#   integrate  examples-run, readme-snippets, init -> run -> export -> vitest, --json shapes,
#              agent surfaces, no key values in shipped docs
#
# Every judge and generator credential is removed. The only network is npm/bun installing
# registry packages. No judge or gateway call, no GitHub call, no publish, no push.
#
# Usage: bash scripts/smoke-release.sh   (env: VETKIT_SMOKE_DIR to choose and keep the scratch root)
set -u

ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
FAILED=0

CREDS=(AI_GATEWAY_API_KEY OPENROUTER_API_KEY CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID TYPESAFE_API_KEY CEV_JUDGE_BASE_URL CI CEV_E2E VITEST VITEST_POOL_ID VITEST_WORKER_ID)
for name in "${CREDS[@]}"; do unset "$name"; done
export NO_COLOR=1

say() { printf 'smoke-release: %s\n' "$*"; }
# What became of the logs under $WORK, for a FAILED verdict: the EXIT trap removes the
# scratch root unless the caller chose it with VETKIT_SMOKE_DIR.
keep_hint() {
  if [ -n "${VETKIT_SMOKE_DIR:-}" ]; then printf '%s' "logs kept at $WORK"; else printf '%s' 'set VETKIT_SMOKE_DIR=<dir> to keep the logs'; fi
}
result() { # <label> <expected> <observed> <ok 0|1> [detail]
  local status=PASS
  if [ "$4" -ne 0 ]; then status=FAIL; FAILED=1; fi
  say "$status $1 (exit $3, expected $2)${5:+ - $5}"
}
exit_is() { result "$1" "$2" "$3" "$([ "$3" -eq "$2" ] && echo 0 || echo 1)"; }
# holds <label> <cmd...>: pass when the command exits 0.
holds() {
  local label="$1"
  shift
  "$@" >/dev/null 2>&1
  local code=$?
  result "$label" 0 "$code" "$code"
}
# fails <label> <detail>: an assertion the caller already evaluated as broken.
fails() { result "$1" 0 1 1 "${2:-}"; }
# is_true <label> <ok 0|1> [detail]
is_true() { result "$1" 0 "$2" "$2" "${3:-}"; }

WORK="${VETKIT_SMOKE_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/vetkit-release.XXXXXX")}"
# The scratch root (a clone, two installs) is removed on exit, pass or fail, when this script
# made it. A directory the caller named with VETKIT_SMOKE_DIR is the caller's to keep.
cleanup() { [ -z "${VETKIT_SMOKE_DIR:-}" ] && rm -rf "$WORK"; return 0; }
trap cleanup EXIT
case "$WORK" in "$ROOT"|"$ROOT"/*) say "scratch dir must be outside the repo: $WORK" >&2; exit 2 ;; esac

for tool in git bun node npm jq tar cmp; do
  command -v "$tool" >/dev/null || { say "required tool '$tool' is not on PATH" >&2; exit 2; }
done

rm -rf "$WORK"
mkdir -p "$WORK"
say "scratch $WORK"

CLONE="$WORK/clone"
TARBALLS="$CLONE/dist-tarballs"
CANARY="sk-fake-smoke-0123456789abcdef"
ISOLATE=(env -u CEV_E2E -u VITEST -u VITEST_POOL_ID -u VITEST_WORKER_ID -u NODE_ENV)

# ---------------------------------------------------------------- section: build
say "== build: clone, install, build, pack"
git clone --quiet "$ROOT" "$CLONE"
exit_is "publish 1a: git clone" 0 $?
(
  cd "$CLONE" || exit 1
  "${ISOLATE[@]}" bun install --frozen-lockfile &&
    "${ISOLATE[@]}" bun run build &&
    "${ISOLATE[@]}" bun run pack
) >"$WORK/build.out" 2>&1
code=$?
exit_is "publish 1b: bun install --frozen-lockfile && bun run build && bun run pack" 0 "$code"
if [ "$code" -ne 0 ]; then
  tail -30 "$WORK/build.out" >&2
  say "FAILED (no tarballs; later sections skipped; $(keep_hint))"
  exit 1
fi
PKG_COUNT="$(find "$CLONE/packages" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
TGZ_COUNT="$(find "$TARBALLS" -maxdepth 1 -name '*.tgz' | wc -l | tr -d ' ')"
is_true "publish 1c: dist-tarballs has one .tgz per packages/* dir ($TGZ_COUNT/$PKG_COUNT)" \
  "$([ "$TGZ_COUNT" -eq "$PKG_COUNT" ] && [ "$TGZ_COUNT" -gt 0 ] && echo 0 || echo 1)"

# ---------------------------------------------------------------- section: tarballs
say "== tarballs: release-check and per-tarball metadata"
(cd "$CLONE" && bun scripts/release-check.ts dist-tarballs) >"$WORK/release-check.out" 2>&1
exit_is "publish 2a: bun scripts/release-check.ts dist-tarballs" 0 $?
holds "publish 2b: release-check prints 'release-check: ok (12 tarballs'" \
  grep -qF 'release-check: ok (12 tarballs' "$WORK/release-check.out"

WANT_ENGINES='^22.18.0 || >=24.11.0'
WANT_REPO='git+https://github.com/MelsovCOZY/vetkit.git'
X="$WORK/x"
mkdir -p "$X"
for tgz in "$TARBALLS"/*.tgz; do
  base="$(basename "$tgz" .tgz)"
  listing="$WORK/$base.list"
  tar -tzf "$tgz" >"$listing"
  pj="$(tar -xzOf "$tgz" package/package.json)"
  holds "publish 3 $base: lists package/LICENSE" grep -qx 'package/LICENSE' "$listing"
  holds "publish 3 $base: lists package/README.md" grep -qx 'package/README.md' "$listing"
  is_true "publish 3 $base: no .map entry" "$(grep -q '\.map$' "$listing" && echo 1 || echo 0)"
  is_true "publish 3 $base: license Apache-2.0" \
    "$([ "$(jq -r .license <<<"$pj")" = 'Apache-2.0' ] && echo 0 || echo 1)"
  is_true "publish 3 $base: engines.node $WANT_ENGINES" \
    "$([ "$(jq -r .engines.node <<<"$pj")" = "$WANT_ENGINES" ] && echo 0 || echo 1)"
  is_true "publish 3 $base: repository url $WANT_REPO" \
    "$([ "$(jq -r .repository.url <<<"$pj")" = "$WANT_REPO" ] && echo 0 || echo 1)"
  is_true "publish 3 $base: LICENSE identical to the repo LICENSE" \
    "$(tar -xzOf "$tgz" package/LICENSE | cmp -s - "$CLONE/LICENSE" && echo 0 || echo 1)"
  mkdir -p "$X/$base"
  tar -xzf "$tgz" -C "$X/$base"
done

# The retired host name is assembled so this file does not itself contain it.
OLD_HOST="vetkit.""dev"
OLD_HITS="$(grep -rlF "$OLD_HOST" "$X" 2>/dev/null | head -3 | tr '\n' ' ')"
is_true "publish 4a: no tarball mentions the retired host name" "$([ -z "$OLD_HITS" ] && echo 0 || echo 1)" "$OLD_HITS"
ENC="$(ls "$X"/vetkit-sink-otel-*/package/dist/encode.js 2>/dev/null | head -1)"
if [ -n "$ENC" ]; then
  is_true "publish 4b: sink-otel dist/encode.js has no classified_evals" \
    "$([ "$(grep -c classified_evals "$ENC")" -eq 0 ] && echo 0 || echo 1)"
else
  fails "publish 4b: sink-otel dist/encode.js exists" "$(ls "$X" | tr '\n' ' ')"
fi

# ---------------------------------------------------------------- section: consumer
say "== consumer: tarballs installed from file: deps and overrides"
# The consumer also installs vitest, pinned to the version this repo is built with (the clone's
# root package.json). The same version goes into `overrides`: npm 10 crashes in its resolver on
# an exact vitest spec older than the newest release, so without the override this install
# would pass or fail depending on what was published last.
write_manifest() { # <dir> <name>
  node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const { execFileSync } = require("node:child_process");
    const [dir, root, out, name] = process.argv.slice(1);
    const deps = {};
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".tgz")).sort()) {
      const full = path.join(dir, file);
      const text = execFileSync("tar", ["-xzOf", full, "package/package.json"], { encoding: "utf8" });
      deps[JSON.parse(text).name] = `file:${full}`;
    }
    const vitest = JSON.parse(fs.readFileSync(root, "utf8")).devDependencies.vitest;
    const manifest = {
      name,
      private: true,
      type: "module",
      dependencies: deps,
      devDependencies: { vitest },
      overrides: { ...deps, vitest },
    };
    fs.writeFileSync(path.join(out, "package.json"), JSON.stringify(manifest, null, 2));
  ' "$TARBALLS" "$CLONE/package.json" "$1" "$2"
}
APP="$WORK/app"
mkdir -p "$APP"
write_manifest "$APP" release-consumer
(cd "$APP" && npm install --ignore-scripts --no-audit --no-fund) >"$WORK/app-install.out" 2>&1
exit_is "publish 5a: npm install --ignore-scripts of every tarball" 0 $?

CLI_JSON="$CLONE/packages/cli/package.json"
WANT_VERSION="$(jq -r .version "$CLI_JSON")"
WANT_DESC="$(jq -r .description "$CLI_JSON")"
cd "$APP" || exit 1
npx vetkit --version >"$WORK/vetkit-version.out" 2>&1
code=$?
is_true "publish 5b: npx vetkit --version prints $WANT_VERSION" \
  "$([ "$code" -eq 0 ] && [ "$(cat "$WORK/vetkit-version.out")" = "$WANT_VERSION" ] && echo 0 || echo 1)" \
  "$(head -c 100 "$WORK/vetkit-version.out")"
npx vet --help >"$WORK/vet-help.out" 2>&1
code=$?
is_true "publish 5c: npx vet --help contains the package description" \
  "$([ "$code" -eq 0 ] && grep -qF "$WANT_DESC" "$WORK/vet-help.out" && echo 0 || echo 1)"

PROJ="$WORK/proj"
cp -R "$CLONE/fixtures/cli/run" "$PROJ"
ln -s "$APP/node_modules" "$PROJ/node_modules"
cp "$APP/package.json" "$PROJ/package.json"
cd "$PROJ" || exit 1
export VETKIT_FIXTURE_MODE=pass VETKIT_FIXTURE_KEY="$CANARY"

# The fixture carries no comments: add one so the migrate step has something to preserve.
sed -i 's/^criteria:$/criteria:\n  # keep-me-comment/' evals/criteria.yaml
npx vet migrate --check --config vetkit.config.ts >"$WORK/m1.out" 2>"$WORK/m1.err"
exit_is "publish 6a: vet migrate --check on an unstamped file" 1 $?
npx vet migrate --config vetkit.config.ts >"$WORK/m2.out" 2>"$WORK/m2.err"
exit_is "publish 6b: vet migrate" 0 $?
is_true "publish 6c: criteria.yaml starts with schemaVersion: 1" \
  "$([ "$(head -1 evals/criteria.yaml)" = 'schemaVersion: 1' ] && echo 0 || echo 1)" "$(head -1 evals/criteria.yaml)"
holds "publish 6d: criteria.yaml comments intact" grep -qF '# keep-me-comment' evals/criteria.yaml
npx vet migrate --check --json --config vetkit.config.ts >"$WORK/m3.out" 2>"$WORK/m3.err"
exit_is "publish 6e: vet migrate --check --json after migrate" 0 $?
holds "publish 6f: migrate --json parses with migrated 0" jq -e '.migrated == 0' "$WORK/m3.out"
npx vet run --config vetkit.config.ts --json >"$WORK/run1.out" 2>"$WORK/run1.err"
exit_is "publish 6g: vet run --json" 0 $?
holds "publish 6h: .vet/runs/latest.json has schemaVersion 1" jq -e '.schemaVersion == 1' .vet/runs/latest.json
LEAK=0
grep -rq "$CANARY" "$PROJ/.vet" "$WORK"/m?.out "$WORK"/m?.err "$WORK"/run1.out "$WORK"/run1.err 2>/dev/null && LEAK=1
is_true "publish 6i: canary key appears in no .vet file, stdout or stderr" "$LEAK"
unset VETKIT_FIXTURE_MODE VETKIT_FIXTURE_KEY

# ---------------------------------------------------------------- section: site
say "== site: staged Pages tree, no fetch"
cd "$CLONE" || exit 1
SITE="$WORK/site"
bun scripts/build-site.ts "$SITE" >"$WORK/site.out" 2>&1
exit_is "publish 7a: bun scripts/build-site.ts" 0 $?
for f in _config.yml index.md docs/lint.md docs/migrate.md docs/configuration.md \
  schemas/criterion.schema.json schemas/source-otlp/otlp.schema.json; do
  holds "publish 7b: site has $f" test -f "$SITE/$f"
done
BASE='https://melsovcozy.github.io/vetkit/'
BAD_IDS=""
while IFS= read -r file; do
  rel="${file#"$SITE"/}"
  id="$(jq -r '."$id" // empty' "$file")"
  [ -n "$id" ] && [ "$id" != "$BASE$rel" ] && BAD_IDS="$BAD_IDS $rel"
done < <(find "$SITE/schemas" -name '*.json' | sort)
is_true "publish 7c: every schema \$id equals $BASE + its path" "$([ -z "$BAD_IDS" ] && echo 0 || echo 1)" "$BAD_IDS"
holds "publish 7d: docs/lint.md has {#escape-missing}" grep -qF '{#escape-missing}' "$SITE/docs/lint.md"
"${ISOLATE[@]}" bun x vitest run scripts/build-site.test.ts >"$WORK/site-test.out" 2>&1
exit_is "publish 7e: vitest run scripts/build-site.test.ts (offline link check)" 0 $?

# ---------------------------------------------------------------- section: metadata
say "== metadata: repo-metadata.sh --dry-run with a gh shim"
SHIM="$WORK/shim"
mkdir -p "$SHIM"
printf '#!/bin/sh\necho "$@" >>"%s/gh-calls"\n' "$SHIM" >"$SHIM/gh"
chmod +x "$SHIM/gh"
PATH="$SHIM:$PATH" bash scripts/repo-metadata.sh --dry-run >"$WORK/meta.out" 2>&1
exit_is "publish 8a: repo-metadata.sh --dry-run" 0 $?
holds "publish 8b: prints the gh repo edit command with description, homepage and topics" \
  bash -c "grep -F 'gh repo edit MelsovCOZY/vetkit --description' '$WORK/meta.out' | grep -F -- '--homepage https://melsovcozy.github.io/vetkit/' | grep -qF -- '--add-topic'"
holds "publish 8c: prints the manual social-preview line" grep -qi 'social preview' "$WORK/meta.out"
is_true "publish 8d: gh was called zero times" "$([ -e "$SHIM/gh-calls" ] && echo 1 || echo 0)"

# ---------------------------------------------------------------- section: units
say "== units: release-facing unit suites"
"${ISOLATE[@]}" bun x vitest run scripts/license.test.ts scripts/package-metadata.test.ts \
  scripts/manifests.test.ts scripts/release-check.test.ts scripts/release.test.ts \
  scripts/public-urls.test.ts scripts/readme.test.ts scripts/community-files.test.ts \
  scripts/workflows-pinned.test.ts scripts/repo-metadata.test.ts scripts/listings.test.ts \
  scripts/docs-gitignore.test.ts >"$WORK/units.out" 2>&1
exit_is "publish 9: release-facing vitest suites" 0 $?

# ---------------------------------------------------------------- section: integrate
say "== integrate: examples, README snippets, init -> run -> export -> vitest"
cd "$CLONE" || exit 1
bash scripts/examples-run.sh dist-tarballs >"$WORK/examples.out" 2>&1
exit_is "integrate 1a: examples-run.sh dist-tarballs" 0 $?
for line in 'examples-run: jsonl ok' 'examples-run: vitest ok' 'examples-run: promptfoo ok' 'examples-run: ai-sdk-otlp ok'; do
  holds "integrate 1b: examples-run prints '$line'" grep -qxF "$line" "$WORK/examples.out"
done
is_true "integrate 1c: examples-run last line is 'examples-run: ok'" \
  "$([ "$(tail -1 "$WORK/examples.out")" = 'examples-run: ok' ] && echo 0 || echo 1)" "$(tail -1 "$WORK/examples.out")"

bun scripts/readme-snippets.ts dist-tarballs >"$WORK/snippets.out" 2>&1
exit_is "integrate 2a: readme-snippets.ts dist-tarballs" 0 $?
LAST="$(tail -1 "$WORK/snippets.out")"
blocks="$(sed -n 's/^readme-snippets: ok (\([0-9][0-9]*\) blocks in \([0-9][0-9]*\) files\(, [0-9][0-9]* skipped\)\{0,1\})$/\1/p' <<<"$LAST")"
files="$(sed -n 's/^readme-snippets: ok (\([0-9][0-9]*\) blocks in \([0-9][0-9]*\) files\(, [0-9][0-9]* skipped\)\{0,1\})$/\2/p' <<<"$LAST")"
is_true "integrate 2b: readme-snippets last line reports >= 6 blocks in >= 3 files" \
  "$([ -n "$blocks" ] && [ "$blocks" -ge 6 ] && [ "$files" -ge 3 ] && echo 0 || echo 1)" "$LAST"

D="$WORK/integrate"
mkdir -p "$D"
cp "$APP/package.json" "$D/package.json"
ln -s "$APP/node_modules" "$D/node_modules"
cd "$D" || exit 1
npx vetkit init >init.out 2>init.err
exit_is "integrate 3: npx vetkit init" 0 $?
npx vet run --json >run.json 2>run.err
exit_is "integrate 4a: npx vet run --json" 0 $?
holds "integrate 4b: run.json has summary, results and model.transport demo" \
  jq -e '.summary and .results and (.model.transport=="demo")' run.json
npx vet export --to vitest >export.out 2>export.err
exit_is "integrate 5a: npx vet export --to vitest" 0 $?
holds "integrate 5b: export prints the include hint" \
  grep -qF 'next: add "evals/vitest/**/*.evals.test.ts" to test.include' export.out
npx vet export --to vitest --json >export.json 2>export.json.err
exit_is "integrate 5c: npx vet export --to vitest --json" 0 $?
holds "integrate 5d: export --json has include and >= 2 files" \
  jq -e '.include == "evals/vitest/**/*.evals.test.ts" and (.files|length) >= 2' export.json
npx vitest run evals/vitest >vitest.out 2>&1
exit_is "integrate 6: npx vitest run evals/vitest (demo judge, emitted files unchanged)" 0 $?
npx vet doctor --json >doctor.json 2>doctor.err
holds "integrate 7: vet doctor --json has checks and exitCode" jq -e '.checks and .exitCode' doctor.json
npx vet lint evals/criteria.yaml --json >lint.json 2>lint.err
holds "integrate 8: vet lint --json has issues array" jq -e '.issues|type=="array"' lint.json
npx vet estimate --json >estimate.json 2>estimate.err
holds "integrate 9: vet estimate --json has for and calls" jq -e '.for and .calls' estimate.json

cd "$CLONE" || exit 1
"${ISOLATE[@]}" bun x vitest run packages/cli/src/json-shapes.test.ts >"$WORK/shapes.out" 2>&1
exit_is "integrate 10: every JSON_SHAPES key produces a validating document" 0 $?
holds "integrate 11: llms.txt has '# vetkit' and '## CLI reference'" \
  bash -c "test -f llms.txt && grep -q '^# vetkit' llms.txt && grep -q '^## CLI reference' llms.txt"
holds "integrate 12: skills/vetkit-setup/SKILL.md opens with a front-matter fence" \
  bash -c "test -f skills/vetkit-setup/SKILL.md && head -1 skills/vetkit-setup/SKILL.md | grep -qx -- '---'"
git check-ignore -q docs/guides/otlp-http-json.md
exit_is "integrate 13: docs/guides/otlp-http-json.md is tracked, not ignored" 1 $?
KEYS="$(grep -rn 'sk-\|AI_GATEWAY_API_KEY=[^$ ]' examples docs/guides llms.txt skills | grep -v '\.env\.example' | grep -v '=$')"
is_true "integrate 14: no key values in examples, guides, llms.txt or skills" "$([ -z "$KEYS" ] && echo 0 || echo 1)" \
  "$(head -c 200 <<<"$KEYS")"

if [ "$FAILED" -ne 0 ]; then say "FAILED ($(keep_hint))"; exit 1; fi
say "ok"
