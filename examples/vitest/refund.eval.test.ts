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
