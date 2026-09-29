<p align="center">
  <img src="assets/logo.png" alt="vetkit logo" width="192" height="192">
</p>

# Contributing to vetkit

vetkit is a library + CLI with no service component: there is no Dockerfile, no compose
file, no CI-built container image, no backup/restore procedure and no health endpoint —
those are explicitly out of scope. This file is the whole ops surface: how to set the repo
up, what each script does, how the release chain works, and how to recover the on-disk
state (`.vet/`, `criteria.lock.json`) that the CLI itself creates.

## Setup

- Bun 1.4.x, pinned via `packageManager` (`bun@1.4.2`) — install from https://bun.sh and
  check with `bun --version`.
- Node >=22.12 (`engines.node`) — Bun runs the scripts and tests, but the release job and
  some tooling still shell out to Node/npm, so a matching Node must be on `PATH`.

Clone, then:

```
bun install --frozen-lockfile
bun run hooks:install
```

## Scripts

Every script below is declared in the root `package.json`; run any of them with `bun run <name>`.

- `bun run typecheck` — `tsc -b tsconfig.json`, a type-check-only build of every workspace
  package's project reference. Run this before `bun run test`: vitest's own typecheck can
  show stale errors otherwise.
- `bun run lint` — `oxlint --type-aware .` plus `scripts/ban-raw-json-parse.sh`, which bans
  raw `JSON.parse(` in `packages/*/src` (the one allowed chokepoint is
  `packages/spec/src/json.ts`'s `safeParseJson`).
- `bun run fmt` — `oxfmt --check .` (single quotes, 100 columns). `bun run fmt:write`
  applies the fixes.
- `bun run test` — `vitest run` across every workspace project.
- `bun run build` — builds every package under `packages/*` with tsdown.
- `bun run pack` — packs each workspace package into `dist-tarballs/*.tgz`, checking that
  every package's `bun.lock`-recorded version matches its `package.json` version and
  scanning the packed contents for leaked `workspace:`/`catalog:` protocol specifiers,
  `bun-types`, or a `from "bun"` import.
- `bun run version` — `changeset version && bun install --no-frozen-lockfile`; this is what
  CI's "Version Packages" job runs, not something you normally run by hand.
- `bun run check` — `typecheck && lint && fmt && test`, the full local gate; run this before
  opening a PR.
- `bun run codegen` — regenerates `@vetkit/spec`'s generated types from the JSON Schemas.
- `bun run hooks:install` — installs the lefthook git hooks (see Hooks below).

## Hooks

`bun run hooks:install` (`lefthook install`) wires a `pre-commit` hook that runs `oxlint`
and `oxfmt --check` on staged files in parallel. The hook is advisory tooling, not a gate on
correctness — CI runs the same checks (plus typecheck and tests) regardless.

To skip the hook for one commit:

```
LEFTHOOK=0 git commit -m "..."
```

CI also runs a PR-title check (`.github/workflows/pr-title.yml`); there is no equivalent
local hook for it, so check your PR title before pushing.

## Release chain

Releases are fully automated by `.github/workflows/release.yml` on every push to `master`.
There is no manual publish step for an ordinary release:

1. `bun install --frozen-lockfile`.
2. If any `.changeset/*.md` files are pending, the `changesets/action` runs
   `bun run version` (`changeset version && bun install --no-frozen-lockfile`), which opens
   or updates a "Version Packages" pull request. Nothing is published on this run.
3. Once that PR is merged and no changesets remain pending, the publish job runs:
   - `bun install --frozen-lockfile` (so `bun.lock` matches the merged manifests exactly).
   - `npm i -g npm@latest` — OIDC trusted publishing needs npm >= 11.5.1
     (https://docs.npmjs.com/trusted-publishers), which the runner's preinstalled npm
     predates.
   - `bun scripts/release-preflight.ts` — checks manifest/`bun.lock` version sync before
     anything is packed.
   - `bun run pack` — writes `dist-tarballs/*.tgz` (see Scripts above for what it checks).
   - `bun scripts/release-preflight.ts --tarballs dist-tarballs` — checks the packed
     tarball contents.
   - For each tarball, in dependency order: skip it if `npm view <name>@<version>` already
     resolves (so a re-run of a partially failed publish job is safe), otherwise
     `npm publish <tgz> --provenance --access public`. The `id-token: write` permission is
     what makes this OIDC trusted publish possible with no long-lived npm token.

## Recovery runbook

Every recovery step below is safe to re-run; none of them can duplicate work or lose data
that already made it to disk.

**A half-drained `.vet/outbox`** (a sink call was interrupted mid-drain): the outbox is
append-only — `pending.jsonl` minus the ids already in `acked.jsonl`/`dead.jsonl` is exactly
what a sink still owes, so re-running the drain resends only what's left:

```
vet check --outbox
```

If the previous process was killed rather than exited cleanly, its `.vet/outbox/.lock` is
taken over automatically once that pid is confirmed dead — you do not need to delete it by
hand.

**A stale `criteria.lock.json`**: `vet check --lock` reports which criteria are stale and
why (wording changed, served model changed, or never calibrated). A wording-only change
(whitespace, comments) can be re-hashed without recalibrating:

```
vet lock refresh
```

Any semantic change (thresholds, new labels, a different served model) leaves the lock
stale until a full revalidation:

```
vet validate
```

**A corrupt `.vet/cache`**: the cache is content-addressed
(`sha256(state, wordingHash, model.resolved)`), one file per verdict, and gitignored. A
corrupted entry is detected on read and treated as a cache miss, so it self-heals on the
next `vet run`. If corruption is widespread, it's safe to delete the whole directory — the
only cost is re-judging, never lost data:

```
rm -rf .vet/cache
```

**An interrupted `vet watch`**: a clean SIGINT prints one JSON coverage summary and exits 0.
A hard kill (`kill -9`, crash, power loss) leaves no summary, but every verdict `vet watch`
judged before dying was already durably enqueued to `.vet/outbox`, so nothing already-judged
is lost. Just restart it — the outbox recovery above resumes the drain.

## Never run

- `bun publish` — Bun has no OIDC trusted publishing and no `--provenance` support
  (oven-sh/bun#22423, open). Use the `npm publish <tgz>` chain above instead.
- `changeset publish` — it publishes straight from the workspace, before `bun run pack`'s
  `workspace:`/`catalog:` protocol substitution runs, so it can leak unresolved
  `workspace:*`/`catalog:` specifiers into a published package.
- Never publish without first running `bun install --frozen-lockfile`: a stale `bun.lock`
  can ship a package at a version that doesn't match what's committed. `bun run pack`'s
  version-sync check exists to catch exactly this.

## Keeping an eval suite fresh

An eval suite rots the moment the traffic it was built from stops matching production:

- Add 100 fresh production traces every 2–4 weeks, plus 10–20 outlier traces every week
  between cycles.
- Review weekly until failure patterns stabilise, then move to monthly.
- Always re-review after an incident or a metric shift, regardless of where you are in the
  cadence above.
- Re-run `vet validate` after any criterion wording edit or a served-model change — a
  lock entry binds one threshold to one exact wording hash and one exact resolved model.
- If a criterion's pass rate saturates at 0% or 100%, send it to transcript review before
  trusting the number: a saturated criterion has stopped discriminating, and the next
  signal it needs is a taxonomy gap, not a passing grade.
