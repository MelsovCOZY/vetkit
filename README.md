# vetkit — LLM evals from your production traces

LLM evals from your production traces: generated, judged by cheap typed decisions, calibrated and gated in CI

It ships an LLM-as-a-judge with typed decisions, a CI gate, vitest export and TypeScript types, and the demo judge needs no API key to try it.

A generator model drafts the criteria and cases; Jev, TypeSafe AI's typed-decision judge and the default judge, answers one typed choice or score question per criterion instead of writing free text; `vet run` turns the verdicts into a pass or fail for the build.

<img src="assets/logo.png" alt="vetkit logo: a pixel-art cat in a vet coat holding a clipboard with a check mark" width="96">

[![npm version](https://img.shields.io/npm/v/vetkit)](https://www.npmjs.com/package/vetkit)
[![npm downloads](https://img.shields.io/npm/dm/vetkit)](https://www.npmjs.com/package/vetkit)
[![CI](https://github.com/MelsovCOZY/vetkit/actions/workflows/ci.yml/badge.svg)](https://github.com/MelsovCOZY/vetkit/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/github/license/MelsovCOZY/vetkit)](LICENSE)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/MelsovCOZY/vetkit/badge)](https://scorecard.dev/viewer/?uri=github.com/MelsovCOZY/vetkit)

[Docs](https://melsovcozy.github.io/vetkit/) · [Quickstart](#quickstart) · [Integrations](examples/) · [GitHub Action](action/README.md) · [llms.txt](https://melsovcozy.github.io/vetkit/llms.txt)

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

![Terminal capture of npx vetkit init followed by npx vetkit run: each case gets a verdict line marked demo, then a hint to set a judge key](assets/vet-run.png)

![HTML report of a vetkit run, written by vet run --reporter html: the pass, fail and unscored counts, the calibration state, the judge model, a table per criterion and the failed cases](assets/vet-report.png)

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

`vet run` is an uncalibrated threshold gate and `vet run --gate` is the calibrated one, which needs labels and a committed `criteria.lock.json`. The steps to the calibrated gate are in the [CI gate walkthrough](docs/ci-gate.md); the action's inputs are in the [action README](action/README.md).

## How it compares

- **Typed-decision judge.** A prompt-based judge returns free text or a number you parse out of it. Jev is a typed-decision judge: it answers a typed choice or score question per criterion, and every verdict records the model id that answered.
- **Calibrated gate.** A threshold on raw judge scores moves when the judge drifts. `vet validate` measures the judge against your labels and writes `criteria.lock.json`; `vet run --gate`, the calibrated gate, enforces that lock with a tolerance band and repeats, and refuses an unpinned judge unless you allow it.
- **Keyless try-out.** `npx vetkit init` with no key writes an offline `demoJudge`, so the first `vet run` needs no key; its verdicts are marked `demo` and never gate a build.

Vendor facts verified for this section: promptfoo's telemetry is on by default, opt out with an env variable ([promptfoo telemetry page](https://www.promptfoo.dev/docs/configuration/telemetry/)); DeepEval's telemetry is on by default, opt out ([DeepEval data privacy page](https://deepeval.com/docs/data-privacy)); the npm manifests of [promptfoo](https://www.npmjs.com/package/promptfoo) 0.123.1 (no install script, native optional packages), [evalite](https://www.npmjs.com/package/evalite) 0.19.0 (native dependency, better-sqlite3) and [braintrust](https://www.npmjs.com/package/braintrust) 3.35.0 (`postinstall` script). vetkit has zero telemetry, no install scripts and no native dependencies.

## Trust

- License: Apache-2.0.
- vetkit has zero telemetry: it makes no network call except to the judge and generator endpoints you configure, and a test fails the build if analytics code appears in shipped sources.
- The packages have no install scripts and no `postinstall`; the release check fails a tarball that has one.
- The judge is Jev, which answers typed choice and score questions and cannot generate text. A gateway preset serves it only as the alias `typesafe-ai/jev`, so each judgment records the served model id and `pinned: false`; the `openrouter` and `typesafe` presets serve a fixed build and record `pinned: true`. `vet run --gate` refuses an unpinned judge unless you allow it.
- Jev scores drift run to run, so thresholds use a tolerance band and at least 3 repeats. Never gate on `confidence` alone.
- Maintenance: releases are cut from master through changesets when changes land, and a deprecated feature stays for at least one minor release, with a notice, before it is removed.

## Coding agents

Point an agent at [llms.txt](https://melsovcozy.github.io/vetkit/llms.txt), the plain-text index of the docs, or give it the [vetkit-setup skill](skills/vetkit-setup/SKILL.md): it installs the package, scaffolds a runnable example, runs it and adds the CI workflow without printing an API key.

## Packages

| Package                                                                       | Purpose                                                                  |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| [`vetkit`](packages/cli)                                                      | the `vet` CLI                                                            |
| [`@vetkit/core`](packages/core)                                               | criteria loading and editing, judging and verdict logic                  |
| [`@vetkit/spec`](packages/spec)                                               | shared types, error codes, JSON validation and adapter contracts         |
| [`@vetkit/judge-jev`](packages/judge-jev)                                     | Jev judge client with configurable transport presets                     |
| [`@vetkit/generator-openai-compatible`](packages/generator-openai-compatible) | generator for any OpenAI-compatible chat endpoint                        |
| [`@vetkit/scorers`](packages/scorers)                                         | Braintrust/autoevals/Evalite scorer, promptfoo assertion, vitest matcher |
| [`@vetkit/export-vitest`](packages/export-vitest)                             | exporter that emits a vitest scorer and test file                        |
| [`@vetkit/source-jsonl`](packages/source-jsonl)                               | trace source reading JSONL                                               |
| [`@vetkit/source-otlp`](packages/source-otlp)                                 | trace source reading OTLP files                                          |
| [`@vetkit/sink-langfuse`](packages/sink-langfuse)                             | sink that writes verdicts as Langfuse scores                             |
| [`@vetkit/sink-otel`](packages/sink-otel)                                     | sink that writes verdicts as OpenTelemetry logs and OpenInference spans  |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, scripts, the release chain and recovery.
