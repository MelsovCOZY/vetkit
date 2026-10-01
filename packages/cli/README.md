# vetkit — LLM evals judged by typed decisions

LLM evals as a CI gate: LLM-as-a-judge with typed decisions, vitest export, TypeScript, no API key to try

A generator model drafts the criteria and cases; Jev, TypeSafe AI's typed-decision judge and the default judge, answers one typed choice or score question per criterion instead of writing free text; `vet run` turns the verdicts into a pass or fail for the build.

<img src="https://raw.githubusercontent.com/MelsovCOZY/vetkit/master/assets/logo.png" alt="vetkit logo: a pixel-art cat in a vet coat holding a clipboard with a check mark" width="96">

[![npm version](https://img.shields.io/npm/v/vetkit)](https://www.npmjs.com/package/vetkit)
[![npm downloads](https://img.shields.io/npm/dm/vetkit)](https://www.npmjs.com/package/vetkit)
[![CI](https://github.com/MelsovCOZY/vetkit/actions/workflows/ci.yml/badge.svg)](https://github.com/MelsovCOZY/vetkit/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/github/license/MelsovCOZY/vetkit)](https://github.com/MelsovCOZY/vetkit/blob/master/LICENSE)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/MelsovCOZY/vetkit/badge)](https://scorecard.dev/viewer/?uri=github.com/MelsovCOZY/vetkit)

[Docs](https://melsovcozy.github.io/vetkit/) · [Quickstart](#quickstart) · [Integrations](https://github.com/MelsovCOZY/vetkit/tree/master/examples) · [GitHub Action](https://github.com/MelsovCOZY/vetkit/blob/master/action/README.md) · [llms.txt](https://melsovcozy.github.io/vetkit/llms.txt)

## Quickstart

```sh
npm i -D vetkit
npx vetkit init
npx vetkit run
```

Requires Node.js `^22.18.0 || >=24.11.0`. With no key set, `npx vetkit init` writes `judge: demoJudge` (imported from 'vetkit') into the config, so the first run needs no key and marks its verdicts `demo`. For real verdicts, put a judge key in `.env`:

```
OPENROUTER_API_KEY=...
```

![Terminal capture of npx vetkit init followed by npx vetkit run: each case gets a verdict line marked demo, then a hint to set a judge key](https://raw.githubusercontent.com/MelsovCOZY/vetkit/master/assets/vet-run.png)

![HTML report of a vetkit run, written by vet run --reporter html: the pass, fail and unscored counts, the calibration state, the judge model, a table per criterion and the failed cases](https://raw.githubusercontent.com/MelsovCOZY/vetkit/master/assets/vet-report.png)

## CI

<!-- snippet: file=.github/workflows/vet.yml -->

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

`vet run` is an uncalibrated threshold gate and `vet run --gate` is the calibrated one, which needs labels and a committed `criteria.lock.json`. The steps to the calibrated gate are in the [CI gate walkthrough](https://melsovcozy.github.io/vetkit/docs/ci-gate.html); the action's inputs are in the [action README](https://github.com/MelsovCOZY/vetkit/blob/master/action/README.md).

## More

Configuration, sinks, watch mode, the trust notes, the package list and the comparison with prompt-based judges are on the docs site: https://melsovcozy.github.io/vetkit/. Source and issues: https://github.com/MelsovCOZY/vetkit.
