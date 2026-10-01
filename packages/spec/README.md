# @vetkit/spec

The contracts every vetkit package shares: the criterion, case, verdict, lock and trace types,
the error codes, JSON Schema validation, secret redaction and the adapter ports (judge, generator,
source, sink, exporter). Import it to write an adapter or to validate vetkit files yourself.

```sh
npm i -D vetkit @vetkit/spec
```

Parse untrusted JSON against a schema and redact a secret before logging:

```ts
import { redactSecrets, safeParseJson } from '@vetkit/spec';

const parsed = safeParseJson<{ id: string }>('{"id":"case-1"}', {
  type: 'object',
  properties: { id: { type: 'string' } },
  required: ['id'],
});
console.log(parsed.ok ? parsed.value.id : parsed.error.code);

console.log(redactSecrets('Authorization: Bearer sk-live-123456', ['sk-live-123456']));
```

---

Part of [vetkit](https://github.com/MelsovCOZY/vetkit): source and issues on GitHub, docs at
[melsovcozy.github.io/vetkit](https://melsovcozy.github.io/vetkit/).
