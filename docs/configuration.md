# Configuration

## Environment variables

`vet doctor` reads these directly; it never prints a value, only whether it is set
(and, with `--reveal-suffix`, the last 4 characters). The full list is exported as
`ENV_VARS` from `packages/cli/src/commands/doctor.ts` — this table and that export
must always name the same set of variables.

| Name | Purpose | Transport |
| --- | --- | --- |
| `AI_GATEWAY_API_KEY` | judge credential for the Vercel AI Gateway transport (typesafe-ai/jev alias) | vercel |
| `OPENROUTER_API_KEY` | judge credential for the OpenRouter Decisions transport | openrouter |
| `CLOUDFLARE_API_TOKEN` | judge credential (paired with `CLOUDFLARE_ACCOUNT_ID`) for the Cloudflare Workers AI transport | cloudflare |
| `CLOUDFLARE_ACCOUNT_ID` | account id (paired with `CLOUDFLARE_API_TOKEN`) for the Cloudflare Workers AI transport | cloudflare |
| `TYPESAFE_API_KEY` | judge credential for the TypeSafe direct transport | typesafe |

Any one of these unblocks the judge; `vet doctor` reports which transport your
environment currently selects (the first present, in the order above), and warns
if more than one is set.

Generator and sink credentials are named by `vetkit.config.ts`, whose schema and
resolver are not implemented yet. Until that
lands, `vet doctor` reports those two rows as a non-fatal warning rather than
naming specific variables.
