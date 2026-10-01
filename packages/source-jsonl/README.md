# @vetkit/source-jsonl

The file trace source for vetkit: reads one trace per line from the JSONL files in a directory so
`vet init` can turn them into criteria and cases. It is the default source, so a bare path works
too. The CLI installs it for you.

```sh
npm i -D vetkit
```

One line per trace, in vetkit's own trace format:

```jsonl
{
  "traceId": "trace-1",
  "messages": [
    {
      "role": "user",
      "parts": [
        {
          "type": "text",
          "content": "Please cancel order 1234."
        }
      ]
    },
    {
      "role": "assistant",
      "parts": [
        {
          "type": "text",
          "content": "Order 1234 has been cancelled and a refund is on its way."
        }
      ]
    }
  ]
}
```

Generate evals from the directory (this calls the configured generator, so it needs a key):

<!-- snippet: skip reason="needs a generator key" -->

```sh
npx vetkit init --source jsonl:traces
```

---

Part of [vetkit](https://github.com/MelsovCOZY/vetkit): source and issues on GitHub, docs at
[melsovcozy.github.io/vetkit](https://melsovcozy.github.io/vetkit/).
