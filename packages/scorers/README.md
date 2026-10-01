<p align="center">
  <img src="https://raw.githubusercontent.com/MelsovCOZY/vetkit/master/assets/logo.png" alt="vetkit logo" width="192" height="192">
</p>

# @vetkit/scorers

Judge-only adapters for teams with an existing eval runner: a Braintrust/autoevals/Evalite
scorer, a promptfoo `javascript` assertion, and a vitest `expect.extend` matcher, all backed by
the same Jev judge (`@vetkit/core`'s `judgeCase` + `decideVerdict` — the same math `vet run`
uses, so cache keys and lock-fitted thresholds match). Zero external runtime dependencies;
`vitest` is an optional, type-only peer.

Every adapter returns `null` (never `0`) for an unscored or escaped (`not_applicable`) result,
so Braintrust, Evalite and autoevals skip it instead of counting it as a fail.

```sh
npm i -D @vetkit/scorers vetkit
```

## Setup

The snippets below share one judge and one criterion. The offline demo judge needs no key and
marks its verdicts `demo`; swap in a real judge (see the `vetkit` README) for real verdicts.

<!-- snippet: file=demo.ts -->

```ts
import type { Criterion } from '@vetkit/spec';
import { demoJudge } from 'vetkit';

export const judge = demoJudge;

export const criterion: Criterion = {
  id: 'promised_refund',
  type: 'boolean',
  instructions: 'Did the assistant promise or issue a refund?',
  escape: 'unclear',
  polarity: 'pass_when_true',
  channel: 'outcome',
  provenance: { traceIds: [] },
  wordingHash: 'readme-demo',
};
```

## Braintrust / autoevals / Evalite

```ts
import { createScorer } from '@vetkit/scorers';
import { criterion, judge } from './demo.ts';

const scorer = createScorer({ judge, criterion });
const input = 'Can I get a refund for order #4411?';
const output = 'Yes. I have issued a full refund for order #4411.';
const { name, score, metadata } = await scorer({ input, output });
// score: 1 | 0 | null (null = unscored or not_applicable, never a fail)
console.log(name, score, metadata.model);
```

## promptfoo

<!-- snippet: file=vetkit.assert.ts -->

```ts
import { toPromptfooAssertion } from '@vetkit/scorers';
import { criterion, judge } from './demo.ts';

export default toPromptfooAssertion({ judge, criterion });
```

<!-- snippet: file=promptfooconfig.yaml -->

```yaml
prompts:
  - '{{input}}'
providers:
  - echo
tests:
  - vars:
      input: 'Assistant: Yes. I have issued a full refund for order #4411.'
    assert:
      - type: javascript
        value: file://vetkit.assert.ts
```

```sh
npx promptfoo eval --no-cache -c promptfooconfig.yaml
```

An escaped (`not_applicable`) criterion returns `{pass: true, score: 0, ...}` so it never fails
the suite; `graderError: true` is reserved for a transport failure (timeout/unavailable/bad
response), never for an escape.

## vitest

<!-- snippet: file=refund.eval.test.ts -->

```ts
import { expect, test } from 'vitest';
import { vetMatchers } from '@vetkit/scorers';
import { criterion, judge } from './demo.ts';

expect.extend(vetMatchers({ judge }));

test('refund is promised', async () => {
  const input = 'Can I get a refund for order #4411?';
  const output = 'Yes. I have issued a full refund for order #4411.';
  await expect(output).toPassCriterion(criterion, { input });
});
```

```sh
npx vitest run
```

Omitting `input` scores the output alone and names that fallback in the failure message.

---

Part of [vetkit](https://github.com/MelsovCOZY/vetkit): source and issues on GitHub, docs at
[melsovcozy.github.io/vetkit](https://melsovcozy.github.io/vetkit/).
