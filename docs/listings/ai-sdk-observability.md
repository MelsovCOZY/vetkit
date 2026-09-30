These are prep texts for the AI SDK Observability directory pull request; agents never submit them, the human opens the PR.

# AI SDK Observability directory pull request

## PR title

docs(providers): add vetkit to the observability integrations

## Provider page text

### vetkit

vetkit turns the traces of an AI SDK app into judged evals. It receives the spans that the AI SDK
emits, converts them to eval cases, and judges them with typed decisions, locally or in CI.

Setup in outline:

1. Enable telemetry on the AI SDK calls with `experimental_telemetry: { isEnabled: true }`.
2. Export spans as OTLP over http/json (for example with
   `@opentelemetry/exporter-trace-otlp-http`, or `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`) to the
   local receiver started by `vet watch`. The receiver accepts http/json only, not protobuf.
3. Run `vet watch` to judge live traffic, or `vet init --source otlp` to draft evals from it.

Full steps: https://melsovcozy.github.io/vetkit/ (the AI SDK telemetry guide; replace with
the guide's direct URL once the Pages site path is known).

vetkit needs no `ai` dependency: it reads standard OpenTelemetry spans and never imports the AI SDK.

## Submission steps

1. Confirm the repository is public and the Pages site with the guide is live.
2. Fork the AI SDK repository and find the observability providers page (see
   https://ai-sdk.dev/providers/observability for the current entry format).
3. Add the vetkit entry using the provider page text above, matching the format of the existing
   entries.
4. Open the pull request with the title above and link the guide.
5. Respond to review comments; do not claim usage numbers in the entry.
