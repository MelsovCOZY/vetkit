---
name: vetkit-setup
description: Use when a project needs LLM evals set up with vetkit, or the user asks to install vetkit, run vet, or add an eval check to CI. Installs the package, scaffolds a runnable example, runs it, and adds the CI workflow without ever printing an API key.
---

# vetkit setup

Set up vetkit in the current project: install, scaffold, run, add CI. Run each step and read its
output before the next one.

## Procedure

1. Detect the package manager from the lockfile: `package-lock.json` is npm, `pnpm-lock.yaml` is
   pnpm, `yarn.lock` is yarn, `bun.lock` or `bun.lockb` is bun. Use npm when there is none.
2. Install the package as a dev dependency with that manager, for example `npm i -D vetkit`.
3. Run `npx vetkit init`. With no key set it writes an offline demo judge, so it needs no
   credentials. It creates `vetkit.config.ts`, `evals/criteria.yaml` and `evals/cases/example.jsonl`.
4. Run `npx vetkit run --json` and read the `summary` field of the JSON document. Report the pass
   and fail counts to the user. Demo verdicts are labelled `demo`: they show that the setup works,
   not how good the model is.
5. To judge with a real model, the user needs a key. Ask the human for the key value; never print, echo, log or paste a key.
   Ask them to add `OPENROUTER_API_KEY=<their key>` to `.env` themselves,
   then run `npx vetkit init --force` so the config switches to the real judge.
6. Add the CI workflow: copy the workflow from `action/README.md` into `.github/workflows/`, and
   tell the user which secret it expects. Use `vet run` in CI; a demo judge is never gateable, so do
   not add a gating flag until a real, calibrated judge is configured.
7. Run `npx vetkit run --json` again and confirm the summary matches the first run.

## What the agent must never do

- Print, echo, log or paste an API key, or write one into a file other than `.env` by the human.
- Commit `.env`.
- Treat a `demo` verdict as a real quality result.
- Edit `criteria.lock.json` by hand.

## Reference

- `npx vetkit --help` lists every command; `--json` works on all of them.
- Full documentation index: https://melsovcozy.github.io/vetkit/llms.txt
