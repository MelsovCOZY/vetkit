# @vetkit/generator-openai-compatible

The generator adapter for vetkit: drafts criteria and cases from your traces through any chat
endpoint that speaks the OpenAI chat-completions protocol (a hosted provider, a gateway or a local
server). The judge stays Jev; the generator only writes drafts for it to check. The CLI installs it
for you.

```sh
npm i -D vetkit
```

Name the endpoint, the model and the env var holding the key in `vetkit.config.ts`:

<!-- snippet: file=vetkit.config.ts -->

```ts
import { defineConfig, demoJudge } from 'vetkit';

export default defineConfig({
  judge: demoJudge,
  generator: {
    kind: 'openai-compatible',
    baseURL: 'https://<your-openai-compatible-endpoint>/v1',
    apiKeyEnv: 'GENERATOR_API_KEY',
    model: '<model id>',
  },
  thresholds: { default: 0.5, perCriterion: {} },
});
```

Then generate evals from a directory of traces:

<!-- snippet: skip reason="needs a generator key" -->

```sh
npx vetkit init --source jsonl:traces
```

---

Part of [vetkit](https://github.com/MelsovCOZY/vetkit): source and issues on GitHub, docs at
[melsovcozy.github.io/vetkit](https://melsovcozy.github.io/vetkit/).
