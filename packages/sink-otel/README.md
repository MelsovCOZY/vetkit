# @vetkit/sink-otel

The OpenTelemetry sink for vetkit: writes every verdict as an OTLP log record, or as OpenInference
spans, to the collector endpoint you configure. Headers such as an auth token come from the env var
you name. The CLI installs it for you.

```sh
npm i -D vetkit
```

Declare the sink in `vetkit.config.ts`:

<!-- snippet: file=vetkit.config.ts -->

```ts
import { defineConfig, demoJudge } from 'vetkit';

export default defineConfig({
  judge: demoJudge,
  sinks: [
    {
      kind: 'otel',
      endpoint: 'http://localhost:4318/v1/logs',
      headersEnv: 'OTEL_EXPORTER_OTLP_HEADERS',
    },
  ],
  thresholds: { default: 0.5, perCriterion: {} },
});
```

Then send a run's verdicts to it:

<!-- snippet: skip reason="needs an OTLP collector" -->

```sh
npx vetkit run --sink otel
```

---

Part of [vetkit](https://github.com/MelsovCOZY/vetkit): source and issues on GitHub, docs at
[melsovcozy.github.io/vetkit](https://melsovcozy.github.io/vetkit/).
