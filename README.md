<p align="center">
  <img src="assets/logo.png" alt="vetkit logo" width="256" height="256">
</p>

<h1 align="center">vetkit</h1>

<p align="center">Generate, validate and run LLM evals from the command line.</p>

## What it is

vetkit is a TypeScript library and CLI (`vet`) for LLM evals. You describe criteria in
`criteria.yaml`, `vet` judges cases against them, and `vet validate` calibrates each criterion
against human labels and records the result in `criteria.lock.json`.

The judge is Jev, a model that answers typed choice and score questions. Jev cannot generate
text, so any step that drafts criteria or cases uses a generator chat model (any
OpenAI-compatible endpoint) and Jev then judges the draft. Nothing in the core is tied to one
model, provider or gateway.

## Install

```
npm i -D vetkit
```

Node >=22.12. The `vet` binary is installed into `node_modules/.bin`.

## Commands

Run `vet --help` for the full list. Global options: `--json`, `-q/--quiet`, `--verbose`,
`--no-color`.

| Command    | What it does                                                            |
| ---------- | ----------------------------------------------------------------------- |
| `doctor`   | check environment, judge credentials and judge endpoint health          |
| `init`     | scaffold a runnable example, or generate criteria and cases from traces |
| `label`    | import human labels from CSV or collect them in a terminal loop         |
| `validate` | calibrate every criterion against human labels and write the lock file  |
| `estimate` | estimate judge calls, tokens, cost and minutes, with no network call    |
| `run`      | judge every case against the criteria and exit with the result          |
| `rerun`    | re-judge disputed verdicts from the last `vet run`                      |
| `check`    | check `criteria.lock.json` and the sink outbox against the project      |
| `lock`     | maintain `criteria.lock.json`                                           |
| `criteria` | disable, enable, delete or revalidate one criterion                     |
| `cases`    | secondary case-set actions: dedupe, quarantine, promote, review         |
| `lint`     | lint `criteria.yaml` against Jev wording weak spots                     |
| `export`   | export criteria, cases and the lock to another eval runner              |
| `watch`    | sample live OTel traces, judge them, and promote failures into cases    |

Exit codes: `0` success, `1` the threshold or gate failed, `2` usage or config error,
`3` nothing could be judged, `130` interrupted.

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
| [`@vetkit/source-langfuse`](packages/source-langfuse)                         | trace source reading Langfuse traces                                     |
| [`@vetkit/sink-langfuse`](packages/sink-langfuse)                             | sink that writes verdicts as Langfuse scores                             |
| [`@vetkit/sink-otel`](packages/sink-otel)                                     | sink that writes verdicts as OpenTelemetry logs and OpenInference spans  |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, scripts, the release chain and recovery.
