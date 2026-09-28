# `vet watch`

Leave `vet watch` running against your OTel collector: it samples live traces deterministically,
judges the sample, and turns every failing trace into a regression case automatically — gated
behind human review before it counts toward any gate. Full contract: `docs/contracts/j7.md`.

## Sampling rule

A trace is sampled iff `hashToUnit(traceId) < sampleRate`, where `hashToUnit` is the first 8 bytes
of `sha256(traceId)` read as a big-endian `uint64`, divided by 2^64. This is deterministic across
restarts and processes — the same trace id always samples the same way, with no in-memory random
state to lose.

Traces whose completeness flags exclude content-dependent criteria (see `docs/contracts/j5.md`
"Completeness → Verdict.status") are recorded but never judged, with reason
`filtered:incomplete` or `filtered:no_content`.

`--sample 0` records everything with `sampled: false` — a dry run that still writes the inclusion
log. `--sample 1` judges everything. When `--upstream-sample-rate` (config `watch.upstreamSampleRate`)
is given, `inclusionProbability = upstreamSampleRate × evaluatorRate`; otherwise both
`upstreamRate` and `inclusionProbability` are `'unknown'`, and any coverage report built from the
log must be labeled a biased sample, not a population estimate.

## Inclusion log

Every trace the receiver yields gets exactly one line — sampled or not, judged or filtered —
appended as JSON to `.vet/watch/inclusion.jsonl` (one `InclusionRecord` object per line):

```ts
interface InclusionRecord {
  traceId: string;
  at: string; // ISO 8601
  sampled: boolean;
  reason: 'rate' | 'filtered:incomplete' | 'filtered:no_content';
  evaluatorRate: number;
  upstreamRate: number | 'unknown';
  inclusionProbability: number | 'unknown';
}
```

The log is the full sampling chain (SDK ratio × tail policy × evaluator rate × filters) — never
only the sampled subset — so a later reweighted estimate, or a "biased sample" label, can be
built from it.

## Promotion: promoted cases and `evals/cases/pending/`

A verdict with `pass: false` and `status: 'ok'` appends one line to
`evals/cases/pending/promoted-<YYYY-MM-DD>.jsonl` (one file per UTC day), shaped:

```ts
interface PromotedCase extends Case {
  provenance: Case['provenance'] & {
    promotedFrom: { traceId: string; criterionId: string; verdictId: string; at: string };
  };
}
```

The id is `promoted-<traceId>-<criterionId>`, never duplicated within a file. `--no-promote`
disables this entirely.

**Pending files are never read by `vet run`.** `evals/cases/pending/` is a subdirectory of the
default cases directory, and `vet run`'s loader only reads `.jsonl` files directly inside
`evals/cases/`, not its subdirectories — so an auto-promoted case is mechanically invisible to
`vet run` until a human moves it up a level with `vet cases review` (into
`evals/cases/promoted-<date>.jsonl` or a quarantine file). An auto-promoted case never counts
toward a gate until reviewed.

## Exit behaviour

`vet watch` is the one documented exception to the CLI-wide "SIGINT → 130" rule, because stopping
a long-running watch is its normal end, not an interruption:

- **First SIGINT**: drains the outbox once, prints the coverage summary
  `{seen, sampled, judged, promoted, produced, acknowledged}`, exits `0`.
- **Second SIGINT** before that drain finishes: exits `130` immediately.
- **Receiver bind failure** (e.g. the port is already in use): exits `2` with `VetError
  RECEIVER_BIND`, naming the port.
- An out-of-range `--sample` (outside `0..1`): exits `2` with `VetError WATCH_CONFIG`.

## Option table

| Flag | Default | Meaning |
|---|---|---|
| `--sample <rate>` | — (required) | The sample rate, `0..1`. Outside that range: `WATCH_CONFIG`, exit 2. |
| `--port <n>` | `4318` | The OTLP/HTTP receiver's port. |
| `--max-in-flight <n>` | `4` | Concurrent judge calls in flight. |
| `--no-promote` | promotion on | Disables writing to `evals/cases/pending/`. |
| `--json` | off | One JSON coverage-summary document on stdout instead of the human-readable form. |
