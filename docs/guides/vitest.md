# LLM evals in vitest with vetkit

Judge an LLM output inside an ordinary vitest test: `await expect(output).toPassCriterion(criterion)`
asks the same judge `vet run` uses, so a criterion from `evals/criteria.yaml` becomes one test per
case with no second runner. Two routes get there: register the matcher from `@vetkit/scorers` and
write the tests by hand, or let `vet export --to vitest` emit the scorer and test files. The working
code lives in [`examples/vitest`](../../examples/vitest/README.md); every TypeScript block below is
one of its files.

## Prerequisites

- A project with vitest and these packages as dev dependencies: `vetkit`, `@vetkit/core` and
  `@vetkit/scorers`.
- Criteria in `evals/criteria.yaml` and cases in `evals/cases/`. `npx vetkit init` scaffolds both.
- A judge. The offline demo judge needs no key; its verdicts are placeholders labelled `demo` and
  never gate a build. Put a real judge in the setup file for real verdicts.

## 1. Register the matcher in a setup file

`vetkit.setup.ts` imports `@vetkit/scorers/vitest` and calls `expect.extend(vetMatchers(...))`, so
`toPassCriterion` type-checks with no hand-written `declare module 'vitest'`. A
`criteria.lock.json` next to the setup file, when present, supplies the calibrated threshold and
tolerance; without it the matcher judges at threshold 0.5.

```ts
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { readLockOrNull } from '@vetkit/core';
import { vetMatchers } from '@vetkit/scorers/vitest';
import { demoJudge } from 'vetkit';

// The lock is optional: without criteria.lock.json (`vet validate` writes it) the matcher
// judges at threshold 0.5. The demo judge is offline; its verdicts are placeholders.
const lock = await readLockOrNull(fileURLToPath(new URL('./criteria.lock.json', import.meta.url)));

expect.extend(vetMatchers({ judge: demoJudge, ...(lock === null ? {} : { lock }) }));
```

List it under `setupFiles` and include the eval tests:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['*.eval.test.ts'],
    setupFiles: ['./vetkit.setup.ts'],
  },
});
```

## 2. One test per case

`loadCriteria` and `loadCases` from `@vetkit/core` read the same files `vet run` reads. The judged
state is `evalCase.input.state`, so the criterion sees the whole conversation and not only the
model's reply.

```ts
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { loadCases, loadCriteria } from '@vetkit/core';

const criteria = await loadCriteria(
  fileURLToPath(new URL('./evals/criteria.yaml', import.meta.url)),
);
const cases = await loadCases(fileURLToPath(new URL('./evals/cases', import.meta.url)));
if (!criteria.ok || !cases.ok) throw new Error('evals/ failed to load');
const criterion = criteria.criteria.find((c) => c.id === 'promised_refund');
if (criterion === undefined) throw new Error('criterion promised_refund is missing');

describe('promised_refund', () => {
  for (const evalCase of cases.cases) {
    test(evalCase.id, async () => {
      await expect(evalCase.input.state).toPassCriterion(criterion);
    });
  }
});
```

`toPassCriterion` also takes an `{ input }` option for a bare output string; omitting `input`
scores the output alone and names that fallback in the failure message.

## 3. Run it

```sh
npx vitest run
```

The example's `npm test` type-checks with `tsc --noEmit` first, then runs vitest.

## Or export native test files

`vet export --to vitest` writes one scorer module per criterion under `scorers/` plus one test
file, by default into `vitest` next to the config (or under `evals/` when that directory exists),
and ends with the glob to add to `test.include` in `vitest.config.ts`:

```sh
vet export --to vitest
```

`--out <dir>` picks another output directory, `--criteria <path...>` exports more than one criteria
file (each into its own subdirectory), and `--require-lock` fails when `criteria.lock.json` is
missing instead of exporting uncalibrated thresholds.

## Calibrated thresholds

Both routes read `criteria.lock.json`, which `vet validate` writes from your own human labels. The
way from the first run to that lock is the [CI gate walkthrough](../ci-gate.md).
