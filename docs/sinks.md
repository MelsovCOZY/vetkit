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
| `classified_evals.*` | extension attributes (judge model resolved id, transport, pinned, wordingHash, cacheHit) |

## `otel-openinference`: OpenInference EVALUATOR span

| Field | Value |
| --- | --- |
| `openinference.span.kind` | `EVALUATOR` |
| span link | exactly ONE span link to `{traceId, spanId}`; never a parent relationship |
| `evaluations.0.evaluation.name` | criterionId |
| `evaluations.0.evaluation.score` | score |
| `evaluations.0.evaluation.label` | label |
| `evaluations.0.evaluation.explanation` | explanation |
| `evaluations.0.evaluation.annotator_kind` | `'JEV'` |
| `evaluations.0.evaluation.identifier` | `<verdict id>` |

## `langfuse`: Scores API `POST /api/public/scores`

| Field | Value |
| --- | --- |
| `traceId` | `provenance.traceId` |
| `observationId` | `provenance.observationId` (optional) |
| `name` | criterionId |
| `value` | the answer's value (`stringValue` for choice) |
| `dataType` | boolean → `BOOLEAN`, choice → `CATEGORICAL` (stringValue), score → `NUMERIC` |
| `comment` | explanation |
| auth | basic auth `base64(pk:sk)` |

## Error codes

| Code | Meaning |
| --- | --- |
| `SINK_REJECTED` | per-item, retryable per sink response |
| `SINK_UNREACHABLE` | network/5xx after retries, retryable |
| `SINK_AUTH` | 401/403, not retryable |
| `SINK_PAYLOAD_TOO_LARGE` | 413 or > 4 MiB batch, split then retry |
| `OUTBOX_CORRUPT` | config error, thrown (not a `doWrite` rejection) |
