# promptfoo example

A promptfoo test whose assertion is a vetkit criterion: `vetkit.assert.ts` exports
`toPromptfooAssertion(...)`, and promptfoo calls it as `(output, context)`. The judged state is
`context.vars.input` (falling back to `context.prompt`, then the output alone), so the criterion
sees the whole conversation and not only the model's reply. The guide
[LLM evals with promptfoo](../../docs/guides/promptfoo.md) walks through the same files.

The judge comes from `judge.ts`: the offline demo judge when no key is set, so the run needs no
network and its verdicts are placeholders labelled `demo`; with `OPENROUTER_API_KEY` set it judges
with Jev through OpenRouter. If a `criteria.lock.json` sits next to the config, the assertion
uses its calibrated threshold and tolerance.

Run it:

```sh
npm test
```
