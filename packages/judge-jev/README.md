# @vetkit/judge-jev

The LLM-as-a-judge adapter for vetkit. Jev answers typed boolean, choice and score questions with
probabilities instead of generating text, which is what makes a verdict a decision rather than a
paraphrase. The adapter reaches Jev through a transport preset (`typesafe`, `vercel`, `openrouter`,
`cloudflare`) and reads the key from the env var you name; it never logs a key or a request body.
The CLI installs it for you.

```sh
npm i -D vetkit
```

Pick a preset in `vetkit.config.ts` and put the key in `.env`:

<!-- snippet: file=vetkit.config.ts -->

```ts
import { defineConfig } from 'vetkit';

export default defineConfig({
  judge: { kind: 'typesafe-compatible', preset: 'openrouter', apiKeyEnv: 'OPENROUTER_API_KEY' },
  thresholds: { default: 0.5, perCriterion: {} },
});
```

`vet doctor` reports which transport your environment selects. Presets that serve a fixed Jev build
record `pinned: true`; the gateway alias records `pinned: false`, which `vet run --gate` refuses
unless allowed.

---

Part of [vetkit](https://github.com/MelsovCOZY/vetkit): source and issues on GitHub, docs at
[melsovcozy.github.io/vetkit](https://melsovcozy.github.io/vetkit/).
