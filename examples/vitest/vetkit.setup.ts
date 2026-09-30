import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { readLockOrNull } from '@vetkit/core';
import { vetMatchers } from '@vetkit/scorers/vitest';
import { demoJudge } from 'vetkit';

// The lock is optional: without criteria.lock.json (`vet validate` writes it) the matcher
// judges at threshold 0.5. The demo judge is offline; its verdicts are placeholders.
const lock = await readLockOrNull(fileURLToPath(new URL('./criteria.lock.json', import.meta.url)));

expect.extend(vetMatchers({ judge: demoJudge, ...(lock === null ? {} : { lock }) }));
