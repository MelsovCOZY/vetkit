# Sinks

A sink writes verdicts back to an observability backend so each one lands on the span it
judged. Every sink implements `SinkV1` from `@vetkit/spec` (`packages/spec/src/ports/sink.ts`)
and is registered through `defineSink()`. The mappings below are copied from
`docs/contracts/j6.md` "Mapping tables".

## Port

- `capabilities.batch` is the largest batch the sink accepts, an integer >= 1 (`defineSink`
  throws `E_ADAPTER_CAPABILITY` otherwise). Splitting a larger batch is the outbox's job, not
  the sink's.
- `capabilities.idempotent` says whether writing the same verdict twice is safe. A sink that is
  not idempotent (Langfuse scores create duplicates on retry) declares `idempotent: false`, and
  the outbox then retries only the ids the ack lists as retryable, never the whole batch.
- `doWrite` returns a `SinkAck`. Its `accepted` and `rejected[].id` values are `Verdict.id`.
- The outbox is single-writer and holds a `.lock` file while it writes.
- Delivery is at-least-once for a sink declaring `idempotent: false`: an unlisted id (neither
  accepted nor rejected) is dead-lettered rather than resent, but a `doWrite` that times out or
  throws after partially writing can still leave a duplicate on the backend.

## Correlation

The ids travel inside `Verdict.provenance` (`traceId`, `spanId`, `responseId`, `observationId`,
`dialect`, `schemaUrl`, all optional strings), so the user handles no ids by hand.

- The correlation rule: `traceId`/`spanId` come from the evaluated span; fall back to
  `gen_ai.response.id` (`provenance.responseId`) when span identifiers are absent.
- A `spanId` without a `traceId` is allowed by the schema but flagged by sinks.
- A verdict with no `traceId`/`spanId` and no `responseId` cannot be correlated: the ack rejects
  it with `reason: 'no correlation id'` and `retryable: false`. The CLI reports it; it is never
  dropped silently.

## Judge failures

The judge-failure rule: `error.type` is set and NO score attributes are emitted when
`verdict.status != 'ok'`.

## `otel`: `gen_ai.evaluation.result` LogRecord

| Field | Value |
| --- | --- |
| `gen_ai.evaluation.name` | criterionId |
| `gen_ai.evaluation.score.value` | boolean → P(true), score → expected level index, choice → credit of the chosen option (1 when chosen == pass option, else 0) |
| `gen_ai.evaluation.score.label` | boolean → pass\|fail, choice → chosen option, score → legend name |
| `gen_ai.evaluation.explanation` | deterministic string built from the answer (`"<criterionId>: p=0.98 >= threshold 0.70 → pass"`) |
| `gen_ai.response.id` | `provenance.responseId` when present |
| `error.type` | `verdict.status` when `status != 'ok'` and NO score attributes |
| LogRecord context | `{ traceId: provenance.traceId, spanId: provenance.spanId }` (hex, as OTLP/JSON requires) |
| `vetkit.*` | extension attributes (`vetkit.model.resolved`, `vetkit.model.transport`, `vetkit.model.pinned`, `vetkit.cache_hit`) |

## `otel-openinference`: OpenInference EVALUATOR span

| Field | Value |
| --- | --- |
| `openinference.span.kind` | `EVALUATOR` |
| span link | exactly ONE span link to `{traceId, spanId}`; never a parent relationship |
| `evaluations.0.evaluation.name` | criterionId |
| `evaluations.0.evaluation.score` | score |
| `evaluations.0.evaluation.label` | label |
| `evaluations.0.evaluation.explanation` | explanation |
| `evaluations.0.evaluation.annotator_kind` | `CODE` for code-graded verdicts (`model.transport` is `code` or `demo`), else `LLM` (OpenInference enum HUMAN\|LLM\|CODE) |
| `vetkit.model.*` | `vetkit.model.resolved`, `vetkit.model.transport`, `vetkit.model.pinned` |
| `evaluations.0.evaluation.identifier` | `<verdict id>` |

## `langfuse`: Scores API `POST /api/public/scores`

| Field | Value |
| --- | --- |
| `traceId` | `provenance.traceId` |
| `observationId` | `provenance.observationId` (optional) |
| `name` | criterionId |
| `value` | boolean → 0\|1, choice → the choice string, score → expected level (number) |
| `dataType` | boolean → `BOOLEAN`, choice → `CATEGORICAL`, score → `NUMERIC` |
| `comment` | explanation |
| `metadata` | `{ model: judge model id (served id, else requested), transport, pinned, sink: '@vetkit/sink-langfuse@<version>' }` |
| auth | basic auth `base64(pk:sk)` |

## Which form does your backend want?

| Descriptor kind | Form | Backends |
| --- | --- | --- |
| `otel` (sink id `otel/logs`) | `gen_ai.evaluation.result` LogRecord | backends that ingest OTLP logs: an OpenTelemetry Collector, Pydantic Logfire |
| `otel/openinference` | EVALUATOR span with one span link | OpenInference-native backends such as Arize Phoenix |
| `langfuse` | Scores API | Langfuse |

Both OTel forms carry the same score, label and explanation, so the choice is about the backend,
not the data. Sources:
[OpenInference annotations](https://github.com/Arize-ai/openinference/blob/main/spec/annotations.md),
[Logfire live evals](https://github.com/pydantic/logfire/blob/main/docs/evaluate/live-evals.md),
[GenAI events](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-events.md).

## Enabling a sink

A sink is off until `vetkit.config.ts` lists it under `sinks`. The CLI builds a `{ kind, *Env }`
descriptor into a sink by reading the named env vars, so no secret appears in the config:

```ts
sinks: [{ kind: 'otel', endpoint: 'http://localhost:4318/v1/logs', headersEnv: 'OTEL_EXPORTER_OTLP_HEADERS' }],
```

Then name the sink on the command line:

```sh
vet run --sink otel
vet watch --sink langfuse
```

`--sink` takes a comma list. A descriptor is named by its `kind` (`otel`, `langfuse`); an adapter
object is named by its `id`, and a name also matches by the id's prefix before `/` when exactly one
configured sink has it. A descriptor's built sink has a different outbox id (`otel/logs`), which is not the name
`--sink` accepts for it. Without `--sink`, `vet watch` drains to every
configured sink.

## Error codes

| Code | Meaning |
| --- | --- |
| `SINK_REJECTED` | per-item, retryable per sink response |
| `SINK_UNREACHABLE` | network/5xx after retries, retryable |
| `SINK_AUTH` | 401/403, not retryable |
| `SINK_PAYLOAD_TOO_LARGE` | 413 or > 4 MiB batch, split then retry |
| `OUTBOX_CORRUPT` | config error, thrown (not a `doWrite` rejection) |
