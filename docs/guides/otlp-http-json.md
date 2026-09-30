# OTLP over http/json

`vet watch` and `vet init --source otlp::<port>` bind their own OTLP/HTTP receiver on
`127.0.0.1:<port>`. It speaks one wire format: OTLP over HTTP with a JSON body.

## What the receiver accepts

- `POST http://127.0.0.1:<port>/v1/traces`
- `content-type: application/json` (a gzip `content-encoding` is fine, bodies up to 16 MiB)

Anything else is refused. The most common exporter default, `http/protobuf`, gets:

```text
HTTP 415
{"error":"json only"}
```

A 415 in your exporter logs means the exporter is sending `application/x-protobuf`. Switch it to
JSON; vet has no protobuf path.

## Point your exporter at vet

Set the protocol with the standard environment variable and the endpoint at the receiver:

```sh
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:4318/v1/traces
```

In Node, use the JSON-over-HTTP exporter, `@opentelemetry/exporter-trace-otlp-http`. The
`-proto` and `-grpc` exporter packages do not work here: they never send `application/json`, so
the receiver answers 415 or never connects.

## Watch or generate

- `vet watch --sample 1 --port 0 --no-promote` judges incoming traces. It needs only a judge, so it
  runs offline on the demo judge.
- `vet init --source otlp::4318 --until 20 --out evals` collects traces and generates criteria and
  cases from them. It needs a configured generator model.

For a full AI SDK app see [AI SDK telemetry](./ai-sdk-telemetry.md).
