# LLM evals with promptfoo and a vetkit assertion

Use a vetkit criterion as a promptfoo `javascript` assertion: `toPromptfooAssertion(...)` from
`@vetkit/scorers` wraps one criterion and one judge into the `(output, context)` function promptfoo
calls, so the pass/fail comes from the same judge `vet run` uses. The working code lives in
[`examples/promptfoo`](../../examples/promptfoo/README.md); every TypeScript and YAML block below
is one of its files.

## Prerequisites

- A promptfoo project with `vetkit`, `@vetkit/core`, `@vetkit/scorers` and `@vetkit/judge-jev` as
  dependencies.
- Criteria in `evals/criteria.yaml`. `npx vetkit init` scaffolds them.
- A judge. The offline demo judge needs no key and no network; its verdicts are placeholders
  labelled `demo`. With `OPENROUTER_API_KEY` set, the example judges with Jev through OpenRouter.

## 1. Pick the judge in one place

```ts
import type { JudgeV1 } from '@vetkit/spec';
import { createJevJudge } from '@vetkit/judge-jev';
import { demoJudge } from 'vetkit';

// The one place that picks the judge: the offline demo judge (placeholder verdicts labelled
// 'demo') unless OPENROUTER_API_KEY is set, then Jev through OpenRouter.
export function pickJudge(): JudgeV1 {
  const apiKey = process.env['OPENROUTER_API_KEY'];
  if (apiKey === undefined || apiKey === '') return demoJudge;
  return createJevJudge({ preset: 'openrouter', apiKey });
}
```

## 2. Export the assertion

`vetkit.assert.ts` loads the criterion and exports the assertion as its default. The judged state
is `context.vars.input`, falling back to `context.prompt`, then to the output alone, so the
criterion sees the whole conversation and not only the model's reply. A `criteria.lock.json` next
to the config, when present, supplies the calibrated threshold and tolerance; without it the
threshold is 0.5.

```ts
import { loadCriteria, readLockOrNull } from '@vetkit/core';
import { toPromptfooAssertion } from '@vetkit/scorers';
import { pickJudge } from './judge.ts';

// Paths are relative to this directory: run `promptfoo eval` from here (`npm test` does).
const criteria = await loadCriteria('evals/criteria.yaml');
if (!criteria.ok) throw new Error('evals/criteria.yaml failed to load');
const criterion = criteria.criteria.find((c) => c.id === 'promised_refund');
if (criterion === undefined) throw new Error('criterion promised_refund is missing');

// The lock is optional: without criteria.lock.json the threshold is 0.5.
const lock = await readLockOrNull('criteria.lock.json');

// promptfoo calls this as (output, context); the judged state is context.vars.input.
export default toPromptfooAssertion({
  judge: pickJudge(),
  criterion,
  ...(lock === null ? {} : { lock }),
});
```

## 3. Reference it from the promptfoo config

```yaml
description: vetkit criterion as a promptfoo assertion
prompts:
  - '{{input}}'
providers:
  - echo
tests:
  - vars:
      input: "User: Can I get a refund for my order #4411?\nAssistant: Yes. I have issued a full refund for order #4411; it will reach your card in 3-5 days."
    assert:
      - type: javascript
        value: file://vetkit.assert.ts
```

## 4. Run it

```sh
npx promptfoo eval --no-cache -c promptfooconfig.yaml
```

An escaped (`not_applicable`) criterion returns `{pass: true, score: 0, ...}` so it never fails the
suite; `graderError: true` is reserved for a transport failure (timeout, unavailable, bad
response), never for an escape.

## Calibrated thresholds

The assertion reads `criteria.lock.json`, which `vet validate` writes from your own human labels.
The way from the first run to that lock is the [CI gate walkthrough](../ci-gate.md).
