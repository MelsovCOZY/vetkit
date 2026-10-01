These are prep texts for the GitHub Marketplace listing; agents never submit them, the human publishes.

# GitHub Marketplace listing

## Listing name

`vetkit`

## Categories

- Primary category: Continuous integration
- Secondary category: Testing

## Tagline

LLM evals from your production traces: generated, judged by cheap typed decisions, calibrated and gated in CI.

## Description

vetkit runs your LLM evals (`vet run`) in CI: it judges each case with typed decisions, uploads
the JUnit report as an artifact and fails the job with the CLI's own exit code.

On pull requests it posts one sticky comment, and writes the job summary, with pass and fail
counts and deltas against the base branch, so a reviewer sees what a change did to the evals
without opening logs.

The gate is calibrated: `gate: true` checks thresholds against a committed calibration lock, with
tolerance bands rather than a single number, and it refuses to run without a lock. Every judgment
records the served judge model and `pinned`; `pinned: false` means the judge alias may drift, and
the gate does not pass on it unless you set `allow-unpinned: true`.

## Prerequisites

- The repository is public.
- A single `action.yml` at the repository root (it is).
- `branding` in `action.yml` with an icon and a color (the values are set there).
- A tagged release: publish the listing from a release whose tag is `v0.x.y`, and keep the moving
  major tag `v0` pointing at it.
- The publishing account has two-factor authentication (2FA) enabled and has accepted the
  GitHub Marketplace Developer Agreement.

## Usage snippet

```yaml
name: vet
on: pull_request
permissions:
  contents: read
  pull-requests: write
jobs:
  vet:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - run: npm ci
      - uses: MelsovCOZY/vetkit@v0
        env:
          OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
```

## Release checklist

1. Confirm the repository is public and `action.yml` has the `branding` icon and color.
2. Confirm the package version, tag and `uses: MelsovCOZY/vetkit@v0` in the README agree.
3. Create the release from a `v0.x.y` tag and move the `v0` tag to it.
4. In the release form, tick "Publish this Action to the GitHub Marketplace".
5. Enter the listing name, categories, tagline and description from this file.
6. Accept the Marketplace terms, publish, then open the listing and check the snippet renders.
