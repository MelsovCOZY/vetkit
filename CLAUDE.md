# vetkit

Unopinionated TypeScript library + CLI that generates, validates and runs LLM evals. TypeSafe AI's Jev
(System One typed decisions) is the judge; any chat model is the generator. Nothing is hard-coded to one
model, provider or gateway. The repo is implemented (packages/, action.yml, docs/, examples/); the design ledger lives in bd. Research briefs are no longer kept in the repo.

## Where things are

- `bd show classified-evals-d4m` — root epic: design, acceptance criteria, DECISION / RISK / PREMISE ledger.
  Every architectural choice is a note there. Read it before proposing anything structural.
- Human gates (`bd gate`) are resolved only by the user. Agents never resolve them.

## Gotchas

- Jev cannot generate text. **Why:** it only answers typed noul/choice/score questions, so every "generate"
  step is two-model: a generator LLM drafts, Jev judges.
- Jev is reached through a configurable transport, default Vercel AI Gateway (`AI_GATEWAY_API_KEY` in `.env`).
  **Why:** TypeSafe registration is closed. The gateway exposes only the alias `typesafe-ai/jev`; record
  the served model id and `pinned: false` on every judgment.
- Jev score answers drift run to run. **Why:** thresholds need tolerance
  bands and N≥3 repeats; never gate on `confidence` alone.
- Bun is the package manager and script runner only. **Why:** the build is tsdown, tests are vitest,
  typecheck is TypeScript 7, and publishing is `bun pm pack` → tarball checks → `npm publish <tgz>` with OIDC.
- The Jev wire format is `instructions` + `criteria` (map for choice, array for score), not `question`/`choices`.

## Do not

- Do not run `bun publish` or `changeset publish`. Use the npm OIDC chain above.
- Do not push, open PRs, or add a git remote unless asked. Commits are local-only and only on request.
- Libraries (@vetkit/*) read process.env only and never read files; the vetkit CLI seeds process.env from ./.env and ./.env.local next to the resolved config (existing env wins) and never logs their values.
  Never log `AI_GATEWAY_API_KEY`, `TYPESAFE_API_KEY`, or judge request/response bodies.
- Do not depend on the `ai` package, add `trustedDependencies`, or ship a `postinstall` script.
- Do not use TodoWrite, TaskCreate or markdown TODO lists. Use bd.
- Do not hard-code Vercel, TypeSafe, OpenRouter or Cloudflare anywhere but their adapter subpath.

## Workflow

- New research goes through the `research` workflow (`~/.claude/workflows/research.js`). Briefs are no
  longer kept in the repo: record the outcome as DECISION/PREMISE notes in bd.
- Coding conventions are in the "Coding conventions" section of `CONTRIBUTING.md`; oxlint and tsconfig
  enforce most of them, so do not restate them here.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:6cd5cc61 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

---

# Behavioral base

Bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" -> "Write tests for invalid inputs, then make them pass"
- "Fix the bug" -> "Write a test that reproduces it, then make it pass"
- "Refactor X" -> "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] -> verify: [check]
2. [Step] -> verify: [check]
3. [Step] -> verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

---

_Source: [forrestchang/andrej-karpathy-skills](https://github.com/forrestchang/andrej-karpathy-skills), derived from Andrej Karpathy's observations on LLM coding pitfalls._
