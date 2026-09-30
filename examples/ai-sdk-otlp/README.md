# AI SDK over OTLP http/json

A Vercel AI SDK app whose `experimental_telemetry` spans go to `vet watch` over OTLP http/json.
Offline it uses a mock model and the demo judge (verdicts are labelled `demo`), so no key is needed.

Files: `otel.ts` (exporter), `app.ts` (the `generateText` call), `vetkit.config.ts`
(demo judge, `watch.sampleRate: 1`) and `test.sh`, which starts `vet watch` on a free port, runs
the app against it, stops watch with SIGINT and checks it saw and judged the trace. The guide
[AI SDK telemetry](../../docs/guides/ai-sdk-telemetry.md) walks through the same code.

Run the proof:

```sh
npm test
```
