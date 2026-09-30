# AI SDK telemetry

Turn the traffic of a Vercel AI SDK app into judged traces or eval cases. The working code lives
in `examples/ai-sdk-otlp`; every TypeScript block below is one of its files.

## 1. Export spans as OTLP http/json

`vet` accepts `application/json` only; an `application/x-protobuf` exporter gets a 415 with
`{"error":"json only"}`. Use the JSON exporter, `@opentelemetry/exporter-trace-otlp-http`, or set
`OTEL_EXPORTER_OTLP_PROTOCOL=http/json` for an env-configured exporter. Never use the `-proto` or
`-grpc` exporters against vet. Details: [OTLP over http/json](./otlp-http-json.md).

```ts
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK } from '@opentelemetry/sdk-node';

// vet accepts OTLP over HTTP with a JSON body only: this exporter sends application/json, and
// the equivalent for an env-configured exporter is OTEL_EXPORTER_OTLP_PROTOCOL=http/json.
const port = process.env['VET_OTLP_PORT'] ?? '4318';

export const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter({ url: `http://127.0.0.1:${port}/v1/traces` }),
});

sdk.start();
```

## 2. Turn on `experimental_telemetry`

`recordInputs` and `recordOutputs` put the conversation text on the spans. They are sent to the
receiver on your own machine only, but they are the content vet judges, so leave both on.

```ts
import { gateway, generateText } from 'ai';
import { MockLanguageModelV2 } from 'ai/test';
import { sdk } from './otel.ts';

// With AI_GATEWAY_API_KEY set the call goes to a real model; without it a mock model returns a
// fixed reply, so the telemetry wiring runs offline. The spans come from generateText itself.
const model = process.env['AI_GATEWAY_API_KEY']
  ? gateway('openai/gpt-4o-mini')
  : new MockLanguageModelV2({
      doGenerate: async () => ({
        content: [{ type: 'text', text: 'Yes. I have issued a full refund to your card.' }],
        finishReason: 'stop',
        usage: { inputTokens: 12, outputTokens: 11, totalTokens: 23 },
        warnings: [],
      }),
    });

try {
  const { text } = await generateText({
    model,
    prompt: 'Can I get a refund for order #4411?',
    experimental_telemetry: { isEnabled: true, recordInputs: true, recordOutputs: true },
  });
  console.log(text);
} finally {
  await sdk.shutdown();
}
```

`sdk.shutdown()` flushes the batch exporter; without it a short script exits before any span is
sent.

## 3. Point the exporter at vet

Judge live traffic. This needs a judge only, so it runs offline on the demo judge:

```sh
vet watch --sample 1 --port 4318 --no-promote
```

Generate criteria and cases from the traffic. This needs a configured generator model:

```sh
vet init --source otlp::4318 --until 20 --out evals
```

`vet init --source otlp::<port>` fails with "no generator configured" until a generator is set;
`vet watch` never needs one. To try the wiring in CI without a key, run `npm test` in
`examples/ai-sdk-otlp`: it starts `vet watch --port 0`, runs the app and asserts the trace was
seen and judged. Add `--json` to `vet watch` for one summary document with `seen` and `judged`.
