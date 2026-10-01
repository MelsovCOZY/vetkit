# @vetkit/source-langfuse

The Langfuse trace source for vetkit: pages through the observations of a Langfuse project and
maps each trace into vetkit's trace format. Credentials are read from the env vars you name, never
from the config file.

```sh
npm i -D vetkit @vetkit/source-langfuse
```

Build the source with the names of the env vars holding the base URL and the keys; it reads lazily
when `doRead` is iterated:

<!-- snippet: skip reason="needs Langfuse credentials" -->

```ts
import { createLangfuseSource } from '@vetkit/source-langfuse';

const source = createLangfuseSource({
  baseUrlEnv: 'LANGFUSE_BASE_URL',
  publicKeyEnv: 'LANGFUSE_PUBLIC_KEY',
  secretKeyEnv: 'LANGFUSE_SECRET_KEY',
});

for await (const trace of source.doRead({})) console.log(trace.traceId);
```

---

Part of [vetkit](https://github.com/MelsovCOZY/vetkit): source and issues on GitHub, docs at
[melsovcozy.github.io/vetkit](https://melsovcozy.github.io/vetkit/).
