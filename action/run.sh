#!/usr/bin/env bash
# Steps of the vetkit composite action (action.yml). Never reads or prints keys: the judge
# adapter reads its own env vars inside `vet`.
#   run.sh install   pick the vet to run: packed tarballs (the selftest), else an explicit published
#                    version installed globally, else the project's own installed vetkit
#   run.sh run       run `vet run --json`, keep the result as .vet/runs/latest.json, set outputs
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

install_tarballs() {
  local dir prefix
  dir="$(cd "$INPUT_TARBALLS" && pwd)"
  prefix="${RUNNER_TEMP:-$(mktemp -d)}/vetkit-install"
  mkdir -p "$prefix"
  # The @vetkit/* packages are not on the registry yet: pin every package name to its tarball,
  # as dependency and as override, so vetkit's own dependencies resolve to them too.
  node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const { execFileSync } = require("node:child_process");
    const [dir, out] = process.argv.slice(1);
    const deps = {};
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".tgz"))) {
      const full = path.join(dir, file);
      const text = execFileSync("tar", ["-xzOf", full, "package/package.json"], { encoding: "utf8" });
      deps[JSON.parse(text).name] = `file:${full}`;
    }
    const manifest = { name: "vetkit-action-install", private: true, dependencies: deps, overrides: deps };
    fs.writeFileSync(path.join(out, "package.json"), JSON.stringify(manifest, null, 2));
  ' "$dir" "$prefix"
  npm install --no-audit --no-fund --prefix "$prefix"
  echo "$prefix/node_modules/.bin" >>"$GITHUB_PATH"
}

# Records how vet was installed for the later `run` step.
set_install_mode() {
  echo "VETKIT_INSTALL_MODE=$1" >>"${GITHUB_ENV:-/dev/null}"
}

install_project() {
  local bin="${GITHUB_WORKSPACE:-$PWD}/node_modules/.bin/vet"
  if [ ! -x "$bin" ]; then
    echo "::error title=vetkit::vetkit is not installed in this project. Run \`npm i -D vetkit\` and install dependencies before this action, or set the \`version\` input to install a published version." >&2
    exit 1
  fi
  set_install_mode project
  echo "vetkit $("$bin" --version | head -n 1) (project)"
}

# Project mode uses the project's own vet (never installs, never fetches another package);
# otherwise `vet` comes from PATH.
vet_cmd() {
  if [ "${VETKIT_INSTALL_MODE:-global}" = "project" ]; then
    npm exec --no -- vet "$@"
  else
    vet "$@"
  fi
}

run_vet() {
  local out code
  mkdir -p .vet/runs .vet/baseline
  # A restored base-branch result is the baseline, not this run's.
  if [ -f .vet/runs/latest.json ]; then mv .vet/runs/latest.json .vet/baseline/latest.json; fi

  local args=(run --json --reporter junit=vet-junit.xml,md=.vet/report.md,html=.vet/report.html)
  if [ -n "${INPUT_CONFIG:-}" ]; then args+=(--config "$INPUT_CONFIG"); fi
  if [ "${INPUT_GATE:-false}" = "true" ]; then args+=(--gate); fi
  if [ "${INPUT_ALLOW_UNPINNED:-false}" = "true" ]; then args+=(--allow-unpinned); fi

  # The raw stdout stays at a fixed path: an error document never becomes latest.json, and the
  # comment step still needs it to name the failure.
  out=.vet/raw.json
  set +e
  vet_cmd "${args[@]}" >"$out"
  code=$?
  set -e

  local outputs
  outputs="$(node "$here/comment.mjs" outputs "$out")"
  # vet is the single writer of .vet/runs/latest.json when it writes one; only
  # fall back to the --json stdout for older vetkit versions that never wrote the file themselves.
  if grep -qx 'hasResult=true' <<<"$outputs" && [ ! -f .vet/runs/latest.json ]; then
    cp "$out" .vet/runs/latest.json
  fi
  {
    echo "exitCode=$code"
    echo "version=$(vet_cmd --version 2>/dev/null | head -n 1 || true)"
    grep -v '^hasResult=' <<<"$outputs"
  } >>"$GITHUB_OUTPUT"
  echo "vet run exited $code"
}

case "${1:-}" in
install)
  if [ -n "${INPUT_TARBALLS:-}" ]; then
    set_install_mode global
    install_tarballs
  elif [ -n "${INPUT_VERSION:-}" ]; then
    set_install_mode global
    npm install -g --no-audit --no-fund "vetkit@${INPUT_VERSION}"
  else
    install_project
  fi
  ;;
run) run_vet ;;
*)
  echo "usage: run.sh install|run" >&2
  exit 64
  ;;
esac
