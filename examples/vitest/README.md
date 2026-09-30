# vitest example

`vetkit.setup.ts` imports `@vetkit/scorers/vitest` and calls `expect.extend(vetMatchers(...))`, so
`await expect(output).toPassCriterion(criterion)` type-checks with no hand-written
`declare module 'vitest'`. `refund.eval.test.ts` loads the cases from `evals/cases` with
`loadCases` and runs one `toPassCriterion` test per case.

The judge is the offline demo judge: verdicts are placeholders labelled `demo` (it answers yes to
everything, so every case passes). Put a real judge in `vetkit.setup.ts` to gate on real verdicts. A
`criteria.lock.json` next to the setup file, when present, supplies the calibrated threshold and
tolerance.

`npm test` type-checks with `tsc --noEmit` (strict, `skipLibCheck` off) and then runs vitest:

```sh
npm test
```
