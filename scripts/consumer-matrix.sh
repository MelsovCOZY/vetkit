#!/usr/bin/env bash
# Installs every packed tarball under one project per package manager (npm, pnpm via
# corepack, yarn via corepack, bun), imports every exports subpath with node, then
# typechecks the same fixture with typescript@7.0.2 and the typescript6 alias, each
# with strict on and off, and finally runs `npx vet --version`.
#
# Usage: scripts/consumer-matrix.sh <tarball-dir>
#
# This is a live integration check (real installs, real network) - it does not run
# under vitest and is not part of the unit test suite.
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <tarball-dir>" >&2
  exit 1
fi

TARBALL_DIR="$(cd "$1" && pwd)"

mapfile -t TARBALLS < <(find "$TARBALL_DIR" -maxdepth 1 -name '*.tgz' | sort)
if [[ ${#TARBALLS[@]} -eq 0 ]]; then
  echo "consumer-matrix: no .tgz files found in $TARBALL_DIR" >&2
  exit 1
fi

require_tool() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "consumer-matrix: required tool '$1' is not on PATH" >&2
    exit 1
  fi
}

require_tool node
require_tool npm
require_tool npx
require_tool corepack
require_tool bun

# pnpm/yarn are corepack-managed, not directly installed; enabling explicitly makes a
# missing manager fail loudly here instead of the later `pnpm`/`yarn` calls skipping
# silently.
corepack enable

FAILURES=()

# One "<package-name>" or "<package-name>/<subpath>" import specifier per line, read
# from every tarball's own package.json exports map - never packages/ in the checked
# out repo - so this script only depends on the tarball directory it is given.
IMPORT_SPECIFIERS="$(mktemp)"
trap 'rm -f "$IMPORT_SPECIFIERS"' EXIT

for tgz in "${TARBALLS[@]}"; do
  tar -xzOf "$tgz" package/package.json | node -e '
    let data = "";
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => {
      const pkg = JSON.parse(data);
      for (const entry of Object.keys(pkg.exports ?? {})) {
        if (entry === "./package.json") continue;
        console.log(entry === "." ? pkg.name : `${pkg.name}/${entry.slice(2)}`);
      }
    });
  ' >>"$IMPORT_SPECIFIERS"
done

write_index_mjs() {
  {
    while IFS= read -r specifier; do
      [[ -z "$specifier" ]] && continue
      printf "import '%s';\n" "$specifier"
    done <"$IMPORT_SPECIFIERS"
    echo "console.log('consumer-matrix: all exports entries imported ok');"
  } >"$1"
}

write_tsconfig() {
  cat >"$1" <<JSON
{
  "compilerOptions": {
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "target": "es2023",
    "strict": $2,
    "noEmit": true
  },
  "include": ["index.mjs"]
}
JSON
}

# Runs one step; on failure, records "<label>" in FAILURES and returns 1 instead of
# aborting, so the rest of the pm x TS x strict matrix still runs and every failing
# combination gets reported, not just the first one.
run_step() {
  local label="$1"
  shift
  echo "consumer-matrix: > ${label}"
  if ! "$@"; then
    echo "consumer-matrix: FAIL: ${label}" >&2
    FAILURES+=("${label}")
    return 1
  fi
}

for pm in npm pnpm yarn bun; do
  require_tool "$pm"

  project_dir="$(mktemp -d)"
  echo "consumer-matrix: === ${pm} ==="
  pushd "$project_dir" >/dev/null

  echo "{\"name\":\"consumer-${pm}\",\"private\":true,\"type\":\"module\"}" >package.json

  case "$pm" in
  npm)
    run_step "${pm} install" npm install --no-audit --no-fund "${TARBALLS[@]}" || true
    ;;
  pnpm)
    printf 'shamefully-hoist=true\n' >.npmrc
    run_step "${pm} install" pnpm add "${TARBALLS[@]}" || true
    ;;
  yarn)
    # Yarn Berry defaults to PnP, which a plain tarball install does not support.
    printf 'nodeLinker: node-modules\n' >.yarnrc.yml
    run_step "${pm} install" yarn add "${TARBALLS[@]}" || true
    ;;
  bun)
    for tgz in "${TARBALLS[@]}"; do
      run_step "${pm} add $(basename "${tgz}")" bun add "${tgz}" || true
    done
    ;;
  esac

  write_index_mjs index.mjs
  run_step "${pm} / node import" node index.mjs || true

  for strict in true false; do
    write_tsconfig "tsconfig.strict-${strict}.json" "${strict}"
    run_step "${pm} / typescript@7.0.2 / strict=${strict}" \
      npx -y -p typescript@7.0.2 tsc --noEmit -p "tsconfig.strict-${strict}.json" || true
    run_step "${pm} / typescript6 / strict=${strict}" \
      npx -y -p @typescript/typescript6@6.0.2 tsc --noEmit -p "tsconfig.strict-${strict}.json" || true
  done

  run_step "${pm} / npx vet --version" npx -y vet --version || true

  popd >/dev/null
  rm -rf "${project_dir}"
done

if [[ ${#FAILURES[@]} -gt 0 ]]; then
  echo "consumer-matrix: ${#FAILURES[@]} combination(s) failed:" >&2
  for f in "${FAILURES[@]}"; do
    echo "  - ${f}" >&2
  done
  exit 1
fi

echo "consumer-matrix: all package manager x TS version x strict-mode combinations passed"
