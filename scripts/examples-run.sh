#!/usr/bin/env bash
# Runs every examples/*/ project keylessly against the packed tarballs: each example is copied
# to a scratch directory, its vetkit dependencies are pointed at the tarballs (`file:` specs plus
# `overrides`, the manifest trick of scripts/consumer-matrix.sh), then the example is installed and
# its test script runs with every judge and generator key var removed from the environment.
#
# Usage: scripts/examples-run.sh <tarball-dir>
#
# This is a live integration check (real installs, real network) - it does not run under vitest
# and is not part of the unit test suite.
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <tarball-dir>" >&2
  exit 1
fi

if [[ ! -d "$1" ]]; then
  echo "examples-run: tarball directory not found: $1" >&2
  exit 1
fi

TARBALL_DIR="$(cd "$1" && pwd)"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

mapfile -t TARBALLS < <(find "$TARBALL_DIR" -maxdepth 1 -name '*.tgz' | sort)
if [[ ${#TARBALLS[@]} -eq 0 ]]; then
  echo "examples-run: no .tgz files found in $TARBALL_DIR" >&2
  exit 1
fi

require_tool() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "examples-run: required tool '$1' is not on PATH" >&2
    exit 1
  fi
}

require_tool node
require_tool npm

# No example may see a real key: every run is offline on the demo judge.
unset AI_GATEWAY_API_KEY OPENROUTER_API_KEY TYPESAFE_API_KEY CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID

# One scratch root holds the tarball manifest and every example copy. It is removed on exit,
# pass or fail.
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT
MANIFEST="$SCRATCH/manifest.json"

node -e '
  const fs = require("node:fs");
  const path = require("node:path");
  const { execFileSync } = require("node:child_process");
  const dir = process.argv[1];
  const packages = {};
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".tgz")).sort()) {
    const full = path.join(dir, file);
    const text = execFileSync("tar", ["-xzOf", full, "package/package.json"], { encoding: "utf8" });
    packages[JSON.parse(text).name] = full;
  }
  fs.writeFileSync(process.argv[2], JSON.stringify({ packages }));
' "$TARBALL_DIR" "$MANIFEST"

# Rewrites the copied example's package.json: every tarball package becomes a `file:` dependency
# (when the example depends on it) and an override, so an internal @vetkit/* range never falls
# through to the registry (those packages are not published). Fails if scripts.test is missing.
# vitest is forced to the version this repo is built with (the root package.json), as an override
# and in the example's own spec (npm rejects an override that disagrees with a direct spec), so
# the install does not depend on which vitest release is the newest: npm 10 crashes in its
# resolver on an exact vitest spec older than the newest release unless it is also overridden.
write_example_manifest() {
  node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const [manifestPath, rootManifest, dir, name] = process.argv.slice(1);
    const { packages } = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const vitest = JSON.parse(fs.readFileSync(rootManifest, "utf8")).devDependencies.vitest;
    const file = path.join(dir, "package.json");
    const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof pkg.scripts?.test !== "string") {
      console.error(`examples-run: ${name} has no scripts.test`);
      process.exit(1);
    }
    const deps = Object.fromEntries(
      Object.entries(packages).map(([pkgName, tarball]) => [pkgName, `file:${tarball}`]),
    );
    for (const field of ["dependencies", "devDependencies"]) {
      for (const pkgName of Object.keys(pkg[field] ?? {})) {
        if (deps[pkgName] !== undefined) pkg[field][pkgName] = deps[pkgName];
        if (pkgName === "vitest") pkg[field][pkgName] = vitest;
      }
    }
    pkg.overrides = { ...pkg.overrides, ...deps, vitest };
    fs.writeFileSync(file, JSON.stringify(pkg, null, 2));
  ' "$MANIFEST" "$ROOT/package.json" "$1" "$2"
}

run_example() {
  local name="$1"
  local dir="$SCRATCH/$name"
  mkdir "$dir"
  cp -R "$ROOT/examples/$name/." "$dir/"
  write_example_manifest "$dir" "$name" || return 1
  (
    cd "$dir"
    npm install --no-audit --no-fund
    npm test
  ) || return 1
  rm -rf "$dir"
}

count=0
for example_dir in "$ROOT"/examples/*/; do
  [[ -d "$example_dir" ]] || continue
  name="$(basename "$example_dir")"
  echo "examples-run: > $name"
  if ! run_example "$name"; then
    echo "examples-run: FAIL $name" >&2
    exit 1
  fi
  echo "examples-run: $name ok"
  count=$((count + 1))
done

if [[ $count -eq 0 ]]; then
  echo "examples-run: no examples found under $ROOT/examples" >&2
  exit 1
fi

echo "examples-run: ok"
