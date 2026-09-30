# JSONL example

Two criteria, four hand-written cases and two own-format traces, judged offline by the demo judge.
Demo verdicts are labelled `demo` in every output and never gate a build; set a key in `.env` (see
`.env.example`) for a real judge.

Run the cases against the criteria:

```sh
npx vet run
```

Estimate the cost of a run without any network call:

```sh
npx vet estimate
```

Turn the traces in `traces/` into new criteria and cases. This calls a generator model, so it needs
a key:

<!-- snippet: skip reason="needs a generator key" -->

```sh
vet init --source jsonl:traces --out evals-generated
```
