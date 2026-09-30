#!/usr/bin/env bash
# Sets the GitHub repository description, homepage and topics from one source (the CLI package
# description). Run by the human at the publish gate; agents only ever run it with --dry-run.
#
# Usage: scripts/repo-metadata.sh [--dry-run]
#
# --dry-run prints the commands without calling gh. GitHub has no API for the social preview
# image, so that step is always printed as a manual step.
set -euo pipefail

REPO=MelsovCOZY/vetkit
HOMEPAGE=https://melsovcozy.github.io/vetkit/
TOPICS=(
  llm-evals
  evals
  llm-evaluation
  llm-as-a-judge
  typescript
  cli
  github-action
  opentelemetry
  ci
  ai-sdk
  ai-testing
)

require_tool() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "repo-metadata: required tool '$1' is not on PATH" >&2
    exit 1
  fi
}

# Prints a command shell-quoted: plain words as they are, other text in double quotes.
print_command() {
  local arg
  for arg in "$@"; do
    if [[ $arg =~ ^[A-Za-z0-9_./:=,@%+-]+$ ]]; then
      printf '%s ' "$arg"
    elif [[ $arg =~ ^[^\"\$\`\\]+$ ]]; then
      printf '"%s" ' "$arg"
    else
      printf '%q ' "$arg"
    fi
  done
  printf '\n'
}

DRY_RUN=0
case "${1:-}" in
  '') ;;
  --dry-run) DRY_RUN=1 ;;
  *)
    echo "usage: $0 [--dry-run]" >&2
    exit 1
    ;;
esac

require_tool gh
require_tool node

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESCRIPTION="$(node -p "require(process.argv[1]).description" "$ROOT/packages/cli/package.json")"

EDIT=(gh repo edit "$REPO" --description "$DESCRIPTION" --homepage "$HOMEPAGE")
for topic in "${TOPICS[@]}"; do
  EDIT+=(--add-topic "$topic")
done
VERIFY=(gh repo view "$REPO" --json description,homepageUrl,repositoryTopics)

if [[ $DRY_RUN -eq 1 ]]; then
  print_command "${EDIT[@]}"
else
  "${EDIT[@]}"
fi

echo 'manual step: upload assets/social-preview.png in Settings -> General -> Social preview (GitHub has no API for it)'

if [[ $DRY_RUN -eq 1 ]]; then
  print_command "${VERIFY[@]}"
else
  "${VERIFY[@]}"
fi
