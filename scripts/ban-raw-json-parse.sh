#!/bin/sh
# Bans raw `JSON.parse(` in packages/*/src. safeParseJson(text, schema) in
# packages/spec/src/json.ts is the one allowed chokepoint.
# POSIX sh only: `sh` is dash on Ubuntu runners (no pipefail, shopt or arrays).
set -eu

src_dirs=""
for dir in packages/*/src; do
  if [ -d "$dir" ]; then
    src_dirs="$src_dirs $dir"
  fi
done

if [ -z "$src_dirs" ]; then
  exit 0
fi

# Word splitting of $src_dirs is intended: workspace paths hold no whitespace.
# shellcheck disable=SC2086
matches=$(grep -rn -F 'JSON.parse(' $src_dirs 2>/dev/null | grep -v '^packages/spec/src/json\.ts:' || true)

if [ -n "$matches" ]; then
  echo "$matches"
  echo "" >&2
  echo "Raw JSON.parse( is banned in packages/*/src. Use the safeParseJson chokepoint" >&2
  echo "(packages/spec/src/json.ts) instead." >&2
  exit 1
fi

exit 0
