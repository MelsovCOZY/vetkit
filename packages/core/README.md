# @vetkit/core

The engine of vetkit: loads and edits criteria and cases, builds judge requests, caches verdicts,
decides pass/fail against a threshold, runs the validation gauntlet and the calibrated gate. It is
what `vet run` and `@vetkit/scorers` call; use it directly to judge a case from your own code.

```sh
npm i -D vetkit @vetkit/core
```

Judge one case against one criterion with the offline demo judge (no key; verdicts are marked
`demo`), then decide pass/fail at a 0.5 threshold:

```ts
import { decideVerdict, judgeCase } from '@vetkit/core';
import type { Case, Criterion } from '@vetkit/spec';
import { demoJudge } from 'vetkit';

const criterion: Criterion = {
  id: 'promised_refund',
  type: 'boolean',
  instructions: 'Did the assistant promise or issue a refund?',
  escape: 'unclear',
  polarity: 'pass_when_true',
  channel: 'outcome',
  provenance: { traceIds: [] },
  wordingHash: 'readme-demo',
};
const evalCase: Case = {
  id: 'case-1',
  input: { state: 'User: Can I get a refund?\nAssistant: Yes, I have issued a full refund.' },
  provenance: {},
  tags: [],
};

const [verdict] = await judgeCase({ judge: demoJudge, case: evalCase, criteria: [criterion] });
if (verdict === undefined) throw new Error('no verdict');
const { pass } = decideVerdict(verdict, criterion, 0.5);
console.log(verdict.status, verdict.model.transport, pass);
```

Swap `demoJudge` for a real judge (see the `vetkit` README) for real verdicts.

---

Part of [vetkit](https://github.com/MelsovCOZY/vetkit): source and issues on GitHub, docs at
[melsovcozy.github.io/vetkit](https://melsovcozy.github.io/vetkit/).
