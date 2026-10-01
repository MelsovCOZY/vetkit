# LLM evals with Langfuse

Write every verdict back to Langfuse as a score on the trace it judged: list a `langfuse` sink in
`vetkit.config.ts`, then run `vet run --sink langfuse` for your case files or
`vet watch --sink langfuse` for live traffic. The ids travel inside each verdict, so you handle no
trace or observation id by hand, and no secret appears in the config. The field-by-field mapping
and the other sink forms are in [Sinks](../sinks.md).

## Prerequisites

- A Langfuse project, with its base URL, public key and secret key in three environment variables.
  The `vet` CLI reads `.env` and `.env.local` next to the config and never logs their values.
- A vetkit project: criteria in `evals/criteria.yaml` and cases in `evals/cases/`
  (`npx vetkit init` scaffolds both), or an app exporting OTel traces to `vet watch`.
- A judge. The offline demo judge needs no key; its verdicts are placeholders labelled `demo`.

## 1. List the sink in the config

A sink is off until `vetkit.config.ts` lists it under `sinks`. A `{ kind, *Env }` descriptor names
the environment variables, never their values; the CLI reads them when it builds the sink. Inside
`defineConfig({ ... })`:

```ts
sinks: [
  {
    kind: 'langfuse',
    baseUrlEnv: 'LANGFUSE_BASE_URL',
    publicKeyEnv: 'LANGFUSE_PUBLIC_KEY',
    secretKeyEnv: 'LANGFUSE_SECRET_KEY',
  },
],
```

All three `*Env` keys are required.

## 2. Name the sink on the command line

```sh
vet run --sink langfuse
vet watch --sink langfuse
```

`--sink` takes a comma list, so `vet run --sink otel,langfuse` writes to both. A descriptor is
named by its `kind`. Without `--sink`, `vet watch` drains to every configured sink.

## 3. What lands in Langfuse

Each verdict becomes one `POST /api/public/scores`:

| Field           | Value                                                                                                                   |
| --------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `traceId`       | `provenance.traceId`                                                                                                    |
| `observationId` | `provenance.observationId` (optional)                                                                                   |
| `name`          | criterionId                                                                                                             |
| `value`         | boolean → 0\|1, choice → the choice string, score → expected level (number)                                             |
| `dataType`      | boolean → `BOOLEAN`, choice → `CATEGORICAL`, score → `NUMERIC`                                                          |
| `comment`       | explanation                                                                                                             |
| `metadata`      | `{ model: judge model id (served id, else requested), transport, pinned, sink: '@vetkit/sink-langfuse@<version>' }`    |
| auth            | basic auth `base64(pk:sk)`                                                                                              |

## Correlation and retries

`traceId` and `spanId` come from the evaluated span, with `gen_ai.response.id` as the fallback when
span identifiers are absent. A verdict with no trace id and no response id cannot be correlated:
the sink rejects it with `reason: 'no correlation id'`, the CLI reports it, and it is never dropped
silently.

Langfuse scores create duplicates on retry, so the sink declares `idempotent: false` and the outbox
retries only the ids the sink lists as retryable, never the whole batch. Delivery is at-least-once:
a write that times out after partially succeeding can still leave a duplicate score. A 401 or 403
is `SINK_AUTH` and is not retried; a network error or 5xx after retries is `SINK_UNREACHABLE`.

## Reading Langfuse traces

`@vetkit/source-langfuse` exports `createLangfuseSource({ baseUrlEnv, publicKeyEnv, secretKeyEnv })`,
a trace source over the Langfuse public API for library use; it reads the same three environment
variables by name. `vet init --source` takes a directory, `jsonl:<dir>` or `otlp::<port>`, and
has no Langfuse prefix.
