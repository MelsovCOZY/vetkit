# @vetkit/source-otlp

The OpenTelemetry trace source for vetkit: reads OTLP JSON files, or receives OTLP/HTTP spans on a
local port, and normalises the GenAI span dialects it detects into vetkit traces. It powers
`vet init --source otlp:...` and the `vet watch` receiver. The CLI installs it for you.

```sh
npm i -D vetkit
```

Generate evals from exported OTLP files, or start the receiver and let `vet watch` judge spans as
your app sends them (point your OTel exporter at the port):

<!-- snippet: skip reason="needs a generator key and an OTLP exporter" -->

```sh
npx vetkit init --source otlp:traces
npx vetkit watch --port 4318
```

---

Part of [vetkit](https://github.com/MelsovCOZY/vetkit): source and issues on GitHub, docs at
[melsovcozy.github.io/vetkit](https://melsovcozy.github.io/vetkit/).
