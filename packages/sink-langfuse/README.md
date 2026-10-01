# @vetkit/sink-langfuse

The Langfuse sink for vetkit: writes every verdict as a Langfuse score on its trace, so pass/fail
and the judge's probability show up next to the trace in Langfuse. Credentials are read from the
env vars you name. The CLI installs it for you.

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
      kind: 'langfuse',
      baseUrlEnv: 'LANGFUSE_BASE_URL',
      publicKeyEnv: 'LANGFUSE_PUBLIC_KEY',
      secretKeyEnv: 'LANGFUSE_SECRET_KEY',
    },
  ],
  thresholds: { default: 0.5, perCriterion: {} },
});
```

Then send a run's verdicts to it:

<!-- snippet: skip reason="needs Langfuse credentials" -->

```sh
npx vetkit run --sink langfuse
```

---

Part of [vetkit](https://github.com/MelsovCOZY/vetkit): source and issues on GitHub, docs at
[melsovcozy.github.io/vetkit](https://melsovcozy.github.io/vetkit/).
