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
