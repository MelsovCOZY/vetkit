# vetkit action

Runs your LLM evals (`vet run`) on every pull request, uploads the reports and the badge file as one
artifact, and keeps one sticky PR comment that says in its first line what happened.

## Prerequisites

- vetkit is a dev dependency of the project: `npm i -D vetkit && npx vetkit init`. The action runs
  the project's own `vet`, so CI uses the version your lockfile pins.
- The workflow checks out the repository and installs its dependencies before the action.
- A judge key in the repository secrets (below).

## Workflow

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

`@v0` is the floating tag for the 0.x releases. The job fails with the exit code of `vet run`.

## Inputs

| Input            | Default               | What it does                                                                                                                                       |
| ---------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config`         | `''`                  | Path to the vetkit config file; empty uses the CLI's own lookup.                                                                                   |
| `gate`           | `false`               | Pass `--gate`: gate on calibrated thresholds. Needs a committed `criteria.lock.json` from `vet validate`; without one the run is refused (exit 2). |
| `allow-unpinned` | `false`               | Pass `--allow-unpinned`: let the gate pass on an unpinned judge.                                                                                   |
| `comment`        | `true`                | On pull requests, upsert the sticky comment.                                                                                                       |
| `comment-id`     | `''`                  | Suffix for the comment marker, so two vetkit steps on one PR keep separate comments. Letters, digits, `-` and `_`, up to 64.                       |
| `node-version`   | `22`                  | Node.js version for setup-node.                                                                                                                    |
| `version`        | `''`                  | Override: a published vetkit version to install globally. Empty uses the project's installed vet.                                                  |
| `tarballs`       | `''`                  | Directory of packed `.tgz` files to install instead of the project's vet or a published version. Wins over the version override.                   |
| `criteria-files` | `**/criteria*.yaml`   | Glob hashed into the baseline cache key.                                                                                                           |
| `cases-files`    | `**/cases/**/*.jsonl` | Glob of case files hashed into the baseline cache key.                                                                                             |
| `config-files`   | `vetkit.config.*`     | Glob of config files hashed into the baseline cache key.                                                                                           |
| `artifact-name`  | `vet-junit`           | Name of the uploaded report artifact.                                                                                                              |
| `github-token`   | `${{ github.token }}` | Token for the PR comment; needs `pull-requests: write`.                                                                                            |

The three globs are relative to the workspace. Editing a case file or the config changes the cache
key, so a pull request never diffs against a baseline computed from the old cases or config. Widen
the globs if your evals live in a subdirectory or in `.config/`.

## Outputs

| Output         | What it holds                                 |
| -------------- | --------------------------------------------- |
| `passed`       | Passed verdicts.                              |
| `failed`       | Failed verdicts.                              |
| `unscored`     | Unscored verdicts.                            |
| `exitCode`     | The `vet run` exit code.                      |
| `version`      | The vetkit version that ran.                  |
| `baseline-key` | The cache key the baseline was restored with. |

## The artifact

The artifact named by `artifact-name` holds:

- `vet-junit.xml`: the JUnit report.
- `.vet/report.md` and `.vet/report.html`: the report as Markdown and as HTML.
- `.vet/badge.json`: a badge in the shields.io endpoint format (`schemaVersion`, `label`, `message`,
  `color`). Its message is the calibration state and the gate result, for example
  `uncalibrated · pass`, and never a pass rate. To show it in a README, publish the file at a public
  URL and point `https://img.shields.io/endpoint?url=` at it.

## The judge key

The action has no key input. Set the judge key in `env:` on the job or the step, as in the workflow
above. `OPENROUTER_API_KEY` uses a pinned judge transport. To use `AI_GATEWAY_API_KEY` instead, set
`allow-unpinned: 'true'` when you gate, because that transport is not pinned.

## The sticky comment

The first line is one of:

- `vetkit: failed`: some cases failed, or the run stopped on an error such as an invalid config or
  criteria file. For an error the comment shows its code and message.
- `vetkit: unscored (judge unavailable)`: the judge could not score (it was down, timed out, throttled
  or its account is out of credit), which is an outage and not a regression.
- `vetkit: auth error (the judge rejected the key named by the config)`: fix the secret.
- `vetkit: gate refused`: `gate: 'true'` could not run, for example with no `criteria.lock.json`.
- `vetkit: passed`: the run exited 0 with no failed case. A run that errored or left no result never
  reads `passed`.

`thresholds uncalibrated: run vet validate` means no committed calibration backs the thresholds.
`pinned: false` means the judge alias may serve a different model between runs, so scores can drift.
The comment links to the workflow run and to the report artifact. The comment never contains judge
requests, verdict payloads or keys.

## Gate tiers

`gate: 'false'` (the default) reports only. `gate: 'true'` fails the job on calibrated thresholds and
needs a committed `criteria.lock.json`; run `vet validate` locally and commit it.

## Permissions and forks

The job needs `contents: read` and `pull-requests: write`. Pull requests from forks get a read-only
token: the comment is skipped with a warning, and the artifact and job result still appear. Use the
`pull_request` trigger. This action is not written for `pull_request_target`.

The action has no working-directory input. In a monorepo, point `config` at the package's config file.

## Troubleshooting

- `vetkit is not installed in this project`: add vetkit to the project's dev dependencies with
  `npm i -D vetkit` and install dependencies before the action, or set `version`. Yarn Plug'n'Play
  projects must set `version`.
- `gate refused: no lock`: run `vet validate`, commit `criteria.lock.json`, or set `gate: 'false'`.
