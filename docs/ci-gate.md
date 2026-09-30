# From first run to a CI gate

`npx vetkit init` scaffolds a project you can run at once: criteria in `evals/criteria.yaml`, cases in
`evals/cases/`, and an example label file. This page takes that project to a gate
that fails a pull request on a calibrated threshold. Every step ends with the command that comes
next.

## Two tiers

`vet run` is the first tier: it judges every case and compares each criterion's pass probability with a
placeholder threshold of 0.5. It prints which tier it used on its last line, and it never claims more:

```
gate: uncalibrated — thresholds are the 0.5 placeholder; run `vet validate` to calibrate
```

The second tier gates on thresholds measured against your own human labels. It needs a lock file,
`criteria.lock.json`, written by `vet validate`, and it is switched on with this flag:

```sh
vet run --gate
```

Without a lock, `vet run --gate` refuses to start and exits 2. With a lock and no flag, `vet run` says so
and stays in the first tier:

```
gate: uncalibrated — criteria.lock.json present; pass --gate to enforce it
```

Exit codes: 0 the run passed, 1 the threshold or gate failed, 2 a usage or config error, 3 nothing
could be judged. The rest of this page is the way from the first tier to the second.

## Label at least 100 cases

A criterion is calibrated only with at least 100 labels for it, of which at least 30 are pass and 30
are fail in the held-out split. That is ≥100 labels per criterion with ≥30 pass and ≥30 fail held out.
A label file is a CSV with this header, one row per case and criterion, and the label is `pass`, `fail`
or `unknown`:

```
case_id,criterion_id,label,labeler,labeled_at
```

`vet init` wrote `evals/labels.csv.example` with three example rows. Copy its header, fill in your own
rows, and import the file. The import writes one file per criterion under `evals/labels/`:

```sh
vet label --from labels.csv
```

Next, decide whether the generator is worth adding.

## Add a generator

The wording checks that run inside `vet validate` include a paraphrase check and a polarity check. Both
need a chat model to rewrite the criterion, so without a generator they are skipped and the criterion stays
uncalibrated. `vet init` left the block commented out in `vetkit.config.ts`; uncomment it and set the
endpoint, the key variable and the model:

```ts
  // generator: {
  //   kind: 'openai-compatible',
  //   baseURL: '<your-openai-compatible-endpoint>/v1',
  //   apiKeyEnv: 'GENERATOR_API_KEY',
  //   model: '<model id>',
  // },
```

Any OpenAI-compatible endpoint works. Next, check that the judge can be pinned.

## Pin the judge

A gate needs a judge whose model does not change under it. The `openrouter` and `typesafe` presets serve a fixed
build and count as pinned; a gateway preset that serves an alias does not, and the gate refuses it unless you
allow it, in the config or on the command line:

```ts
gate: { allowUnpinned: true },
```

```sh
vet run --gate --allow-unpinned
```

Prefer a pinned preset. Then measure what validation will cost.

## Validate

`vet estimate --for validate` prints the judge calls, tokens, cost and minutes for calibration without
any network call:

```sh
vet estimate --for validate
```

`vet validate` prints the same line before it starts. Its shape is:

```
estimate: 300 judge calls, ~90000 input tokens, cost $0.450000, ~12.0 min at 25 calls/min (breakdown: vet estimate --for validate)
```

Calibration judges each labelled case at least 3 times, because scores drift from run to run. Run it:

```sh
vet validate --repeats 3
```

It writes `criteria.lock.json`. Next, commit that file.

## Commit the lock

The lock binds one threshold to the exact wording of a criterion and the exact model that served it.
Commit it with the criteria, and check in CI that it still matches:

```sh
vet check --lock criteria.lock.json
```

A match prints one line and exits 0:

```
fresh: criteria.lock.json matches the criteria and cases
```

If you edit a criterion or the served model changes, the check reports it as stale and exits 1; run
`vet validate` again. `vet run --gate` refuses (exit 2) a lock whose gated criteria wording or request
format changed since calibration, so run `vet check` first to see what went stale. Next, gate in CI.

## Gate in CI

Run the calibrated tier in the pull request job. A case whose repeats disagree beyond the tolerance band is
reported as flaky, and under the gate a flaky case fails the run with exit 1, so use three repeats:

```sh
vet run --gate --repeat 3
```

```
flaky refund-partial (spread 0.31)
```

The [action](../action/README.md) runs the same command; set its `gate` input to true. Next, keep the
judge calls out of your test loop.

## Rerun offline

`--record` writes every judge response to a directory, and `--replay` answers from that directory with no
credential and no network, so a CI job can rerun a recorded run:

```sh
vet run --record .vet/recorded
vet run --replay .vet/recorded
```
