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

# packages: "<package-name>" -> absolute tarball path. specifiers: one
# "<package-name>" or "<package-name>/<subpath>" import specifier per entry, both read
# from every tarball's own package.json (name, exports) - never packages/ in the
# checked out repo - so this script only depends on the tarball directory it is given.
MANIFEST="$(mktemp)"
trap 'rm -f "$MANIFEST"' EXIT

node -e '
  const fs = require("node:fs");
  const path = require("node:path");
  const { execFileSync } = require("node:child_process");
  const dir = process.argv[1];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".tgz")).sort();
  const packages = {};
  const specifiers = [];
  let version = "";
  for (const file of files) {
    const full = path.join(dir, file);
    const text = execFileSync("tar", ["-xzOf", full, "package/package.json"], { encoding: "utf8" });
    const pkg = JSON.parse(text);
    packages[pkg.name] = full;
    if (pkg.name === "vetkit") version = pkg.version;
    for (const entry of Object.keys(pkg.exports ?? {})) {
      if (entry === "./package.json") continue;
      specifiers.push(entry === "." ? pkg.name : `${pkg.name}/${entry.slice(2)}`);
    }
  }
  fs.writeFileSync(process.argv[2], JSON.stringify({ packages, specifiers, version }));
' "$TARBALL_DIR" "$MANIFEST"

write_index_mjs() {
  node -e '
    const fs = require("node:fs");
    const { specifiers } = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const lines = specifiers.map((specifier) => `import ${JSON.stringify(specifier)};`);
    lines.push("console.log(\"consumer-matrix: all exports entries imported ok\");");
    fs.writeFileSync(process.argv[2], `${lines.join("\n")}\n`);
  ' "$MANIFEST" "$1"
}

write_tsconfig() {
  cat >"$1" <<JSON
{
  "compilerOptions": {
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "target": "es2023",
    "strict": $2,
    "allowJs": true,
    "noEmit": true
  },
  "include": ["index.mjs"]
}
JSON
}

# Writes a consumer package.json (dependencies pinned to every tarball's absolute
# `file:` path) plus whatever override mechanism that package manager needs so a
# package's own internal @vetkit/* dependency range never falls through to the
# registry (those packages are not published): npm/bun read root "overrides", Yarn
# reads "resolutions" (and is pinned to Yarn Berry via "packageManager" so the
# nodeLinker override below applies), and pnpm reads "overrides" from
# pnpm-workspace.yaml, not from package.json.
write_consumer_manifest() {
  local pm="$1"
  local out_dir="$2"
  node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const [manifestPath, outDir, pm] = process.argv.slice(1);
    const { packages } = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const deps = Object.fromEntries(
      Object.entries(packages).map(([name, tarballPath]) => [name, `file:${tarballPath}`]),
    );
    const manifest = { name: `consumer-${pm}`, private: true, type: "module", dependencies: deps };
    if (pm === "npm" || pm === "bun") manifest.overrides = deps;
    if (pm === "yarn") {
      manifest.packageManager = "yarn@4.5.0";
      manifest.resolutions = deps;
    }
    fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify(manifest, null, 2));
    if (pm === "pnpm") {
      const lines = ["overrides:"];
      for (const [name, spec] of Object.entries(deps)) {
        lines.push(`  ${JSON.stringify(name)}: ${JSON.stringify(spec)}`);
      }
      fs.writeFileSync(path.join(outDir, "pnpm-workspace.yaml"), `${lines.join("\n")}\n`);
    }
  ' "$MANIFEST" "$out_dir" "$pm"
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

# Runs `npx <bin> --version` (no -y) and stores its stdout in the named variable.
capture_version() {
  printf -v "$1" '%s' "$(npx "$2" --version)"
}

for pm in npm pnpm yarn bun; do
  require_tool "$pm"

  project_dir="$(mktemp -d)"
  echo "consumer-matrix: === ${pm} ==="
  pushd "$project_dir" >/dev/null

  write_consumer_manifest "$pm" "$project_dir"

  case "$pm" in
  npm)
    run_step "${pm} install" npm install --no-audit --no-fund || true
    ;;
  pnpm)
    printf 'shamefully-hoist=true\n' >.npmrc
    run_step "${pm} install" pnpm install || true
    ;;
  yarn)
    # Yarn Berry defaults to PnP, which the file:-tarball dependencies above do not support.
    printf 'nodeLinker: node-modules\n' >.yarnrc.yml
    # Yarn turns on immutable installs when CI=true, which forbids creating the
    # yarn.lock a fresh consumer project starts without.
    run_step "${pm} install" env YARN_ENABLE_IMMUTABLE_INSTALLS=false yarn install || true
    ;;
  bun)
    run_step "${pm} install" bun install || true
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

  # No -y: an unlisted `vet` would resolve to an unrelated registry package.
  vet_v=""
  vetkit_v=""
  run_step "${pm} / npx vet --version" capture_version vet_v vet || true
  run_step "${pm} / npx vetkit --version" capture_version vetkit_v vetkit || true
  expected="$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).version)' "$MANIFEST")"
  run_step "${pm} / vet and vetkit versions agree" \
    test -n "$expected" -a "$vet_v" = "$vetkit_v" -a "$vet_v" = "$expected" || true

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
