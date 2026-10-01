# LLM evals as a GitHub Actions CI gate

Run your LLM evals on every pull request with the vetkit action: it runs the project's own
`vet run`, uploads the reports and the badge file as one artifact, keeps one sticky PR comment that
says in its first line what happened, and fails the job with the exit code of `vet run`. This page
is the shortest path from a workflow file to a calibrated gate; every input and output is listed in
the [action README](../../action/README.md).

## Prerequisites

- vetkit is a dev dependency of the project: `npm i -D vetkit && npx vetkit init`. The action runs
  the project's own `vet`, so CI uses the version your lockfile pins.
- The workflow checks out the repository and installs its dependencies before the action.
- A judge key in the repository secrets (below).

## 1. Add the workflow

Copy this into `.github/workflows/vet.yml` and add the `OPENROUTER_API_KEY` secret:

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

`@v0` is the floating tag for the 0.x releases. The job needs `contents: read` and
`pull-requests: write`. Use the `pull_request` trigger; the action is not written for
`pull_request_target`. Pull requests from forks get a read-only token: the comment is skipped with
a warning, and the artifact and job result still appear.

## 2. The judge key

The action has no key input. Set the judge key in `env:` on the job or the step, as above.
`OPENROUTER_API_KEY` uses a pinned judge transport. To use `AI_GATEWAY_API_KEY` instead, set
`allow-unpinned: 'true'` when you gate, because that transport is not pinned.

## 3. What a run leaves behind

The sticky comment's first line is one of `vetkit: passed`, `vetkit: failed`,
`vetkit: unscored (judge unavailable)`, `vetkit: auth error (the judge rejected the key named by the config)`
or `vetkit: gate refused`. It links to the workflow run and to the report artifact, and never
contains judge requests, verdict payloads or keys.

The artifact named by `artifact-name` (default `vet-junit`) holds `vet-junit.xml`, the report as
`.vet/report.md` and `.vet/report.html`, and `.vet/badge.json` in the shields.io endpoint format;
`.vet/` is next to the config given by `config`, or in the working directory when `config` is
empty. The outputs `passed`, `failed`, `unscored`, `exitCode`, `version` and `baseline-key` are
available to later steps.

## 4. Gate on calibrated thresholds

`gate: 'false'` (the default) reports only: thresholds are the 0.5 placeholder, and the comment says
`thresholds uncalibrated: run vet validate`. `gate: 'true'` passes `--gate` and fails the job on
thresholds calibrated against your own labels. It needs a committed `criteria.lock.json`; without
one the run is refused (exit 2) and the comment reads `vetkit: gate refused`. Switch it on with
`gate: 'true'` under `with:` on the `MelsovCOZY/vetkit@v0` step.

To write the lock, label at least 100 cases per criterion, run `vet validate`, and commit
`criteria.lock.json` with the criteria. `vet check --lock criteria.lock.json` tells you when a
criterion or the served model changed since calibration. The whole path, from the first `vet run`
to the lock, is the [CI gate walkthrough](../ci-gate.md).

## 5. Monorepos and two steps on one PR

The action has no working-directory input. In a monorepo, point `config` at the package's config
file; `.vet/` and the reports then live next to it. Two vetkit steps on one pull request keep
separate comments when each sets a different `comment-id`. Editing a case file, a criteria file or
the config changes the baseline cache key; widen `criteria-files`, `cases-files` or `config-files`
if your evals live in a subdirectory.

## Troubleshooting

- `vetkit is not installed in this project`: add vetkit to the project's dev dependencies with
  `npm i -D vetkit` and install dependencies before the action, or set `version`. Yarn Plug'n'Play
  projects must set `version`.
- `gate refused: no lock`: run `vet validate`, commit `criteria.lock.json`, or set `gate: 'false'`.
