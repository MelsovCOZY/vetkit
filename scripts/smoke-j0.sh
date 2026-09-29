#!/bin/sh
# J0 slice-gate smoke: proves a clean `git clone` of HEAD
# builds, packs and installs on the local consumer matrix.
#
# Sequence: git clone HEAD into a mktemp dir (never `git worktree add`) -> in the clone,
# `bun install --frozen-lockfile && bun run check && bun run build && bun run pack` ->
# assert dist-tarballs/ has one .tgz per packages/* directory -> run
# scripts/consumer-matrix.sh dist-tarballs (npm/pnpm/yarn/bun installs, every exports
# path, consumer tsc under typescript 7 and the typescript6 alias with strict on/off,
# no @types/bun, `npx vet --version` prints 0.0.0) -> print `smoke-j0: ok`.
#
# CI-only, not run locally: this script and its consumer-matrix step only prove Node 22
# (the local toolchain: PREMISE `node --version` -> v22.23.2). The ci.yml matrix job
# additionally runs the same two steps on Node 24 and 26; that repeat needs an actual CI
# run and is not exercised by this script (PREMISE: the repo has no git remote yet, so
# CI has never run).
#
# Usage: sh scripts/smoke-j0.sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

for tool in git bun; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "smoke-j0: required tool '$tool' is not on PATH" >&2
    exit 1
  fi
done

CLONE_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$CLONE_DIR"
}
trap cleanup EXIT

echo "smoke-j0: cloning HEAD of $ROOT into $CLONE_DIR"
git clone --quiet "$ROOT" "$CLONE_DIR"

(
  cd "$CLONE_DIR"
  env -u CEV_E2E -u VITEST -u VITEST_POOL_ID -u VITEST_WORKER_ID -u NODE_ENV \
    bun install --frozen-lockfile
  env -u CEV_E2E -u VITEST -u VITEST_POOL_ID -u VITEST_WORKER_ID -u NODE_ENV \
    bun run check
  env -u CEV_E2E -u VITEST -u VITEST_POOL_ID -u VITEST_WORKER_ID -u NODE_ENV \
    bun run build
  env -u CEV_E2E -u VITEST -u VITEST_POOL_ID -u VITEST_WORKER_ID -u NODE_ENV \
    bun run pack
)

PACKAGE_COUNT=$(find "$CLONE_DIR/packages" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')
TARBALL_COUNT=$(find "$CLONE_DIR/dist-tarballs" -maxdepth 1 -name '*.tgz' | wc -l | tr -d ' ')

if [ "$TARBALL_COUNT" -ne "$PACKAGE_COUNT" ]; then
  echo "smoke-j0: expected $PACKAGE_COUNT tarballs (one per packages/* directory), found $TARBALL_COUNT in dist-tarballs/" >&2
  exit 1
fi
echo "smoke-j0: dist-tarballs/ has $TARBALL_COUNT/$PACKAGE_COUNT tarballs"

sh "$CLONE_DIR/scripts/consumer-matrix.sh" "$CLONE_DIR/dist-tarballs"

echo "smoke-j0: ok"
