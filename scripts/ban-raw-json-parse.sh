#!/usr/bin/env bash
# Bans raw `JSON.parse(` in packages/*/src. safeParseJson(text, schema) in
# packages/spec/src/json.ts is the one allowed chokepoint (docs/contracts/j0.md).
set -euo pipefail

shopt -s nullglob
src_dirs=(packages/*/src)

if [ "${#src_dirs[@]}" -eq 0 ]; then
  exit 0
fi

matches=$(grep -rn -F 'JSON.parse(' "${src_dirs[@]}" 2>/dev/null | grep -v '^packages/spec/src/json\.ts:' || true)

if [ -n "$matches" ]; then
  echo "$matches"
  echo "" >&2
  echo "Raw JSON.parse( is banned in packages/*/src. Use the safeParseJson chokepoint" >&2
  echo "(packages/spec/src/json.ts) instead." >&2
  exit 1
fi

exit 0
