# @vetkit/scorers

Judge-only adapters for teams with an existing eval runner: a Braintrust/autoevals/Evalite
scorer, a promptfoo `javascript` assertion, and a vitest `expect.extend` matcher, all backed by
the same Jev judge (`@vetkit/core`'s `judgeCase` + `decideVerdict` — the same math `vet run`
uses, so cache keys and lock-fitted thresholds match). Zero external runtime dependencies;
`vitest` is an optional, type-only peer.

Every adapter returns `null` (never `0`) for an unscored or escaped (`not_applicable`) result,
so Braintrust, Evalite and autoevals skip it instead of counting it as a fail.

## Braintrust / autoevals / Evalite

```ts
import { createScorer } from '@vetkit/scorers';

const scorer = createScorer({ judge, criterion });
const { name, score, metadata } = await scorer({ input, output });
// score: 1 | 0 | null (null = unscored or not_applicable, never a fail)
```

## promptfoo

```ts
// vetkit.assert.ts
import { toPromptfooAssertion } from '@vetkit/scorers';

export default toPromptfooAssertion({ judge, criterion });
```

```yaml
# promptfooconfig.yaml
assert:
  - type: javascript
    value: file://vetkit.assert.ts
```

An escaped (`not_applicable`) criterion returns `{pass: true, score: 0, ...}` so it never fails
the suite; `graderError: true` is reserved for a transport failure (timeout/unavailable/bad
response), never for an escape.

## vitest

```ts
import { expect } from 'vitest';
import { vetMatchers } from '@vetkit/scorers';

expect.extend(vetMatchers({ judge }));

await expect(output).toPassCriterion(criterion, { input });
```

Omitting `input` scores the output alone and names that fallback in the failure message.
