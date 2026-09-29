// docs/contracts/j7.md "Promotion".
//
// promoteFailure is called directly as loop.ts's `onVerdict` (RunWatchInput.onVerdict:
// `(verdict: Verdict, evalCase: Case) => boolean | void`) — synchronous, one
// verdict at a time. That is why this module writes with sync fs calls
// (appendFileSync/readFileSync, same pattern as sampler.ts's inclusion log) rather than the
// outbox's async files.ts helper (appendLines/scanLines): an async promoteFailure could not
// satisfy onVerdict's synchronous contract, and the loop checks `onVerdict(v, c) === true`
// without awaiting it.
//
// `evalCase` (the bead's acceptance-criteria text calls this second parameter `trace`) is the
// Case the failing verdict was judged against, carrying the `traceId` this module needs.
// `verdict.id` is exactly the id `outbox.enqueue` assigned that verdict (fixed loop.ts
// to thread it through onVerdict): a verdict with no id is never promoted here — synthesizing
// one would silently mismatch whatever the outbox actually wrote for it.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { safeParseJson, type Case, type JsonSchema, type Verdict } from '@vetkit/spec';
import type { PromotedCase } from './types.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface PromoteFailureOptions {
  /** Defaults to `new Date()`. Lets a caller/test pin the day file and `at` timestamp. */
  readonly now?: Date;
}

function dayFile(dir: string, now: Date): string {
  const iso = now.toISOString().slice(0, 10); // YYYY-MM-DD
  return join(dir, 'pending', `promoted-${iso}.jsonl`);
}

interface IdLine {
  readonly id: string;
}

const ID_LINE_SCHEMA: JsonSchema = {
  type: 'object',
  properties: { id: { type: 'string' } },
  required: ['id'],
};

// Best-effort dedupe read through the one JSON.parse chokepoint (safeParseJson): a corrupt
// or non-matching line is skipped rather than thrown (this is a dedupe check, not the J1
// loader's validation).
function existingIds(file: string): Set<string> {
  const ids = new Set<string>();
  if (!existsSync(file)) return ids;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line === '') continue;
    const parsed = safeParseJson<IdLine>(line, ID_LINE_SCHEMA);
    if (parsed.ok) ids.add(parsed.value.id);
  }
  return ids;
}

/**
 * Appends one `PromotedCase` line to `<dir>/pending/promoted-<YYYY-MM-DD>.jsonl` for a
 * failing, `status: 'ok'` verdict, skipping a duplicate id already in that file. Returns
 * whether a line was appended (`false` covers: not a failure, no `evalCase` to promote from,
 * no `verdict.id`, or a duplicate) — never throws.
 */
export function promoteFailure(
  verdict: Verdict,
  evalCase: Case | undefined,
  dir: string,
  options: PromoteFailureOptions = {},
): boolean {
  if (verdict.status !== 'ok' || verdict.pass !== false) return false;
  if (evalCase?.traceId === undefined) return false;
  if (verdict.id === undefined) return false;

  const now = options.now ?? new Date();
  const file = dayFile(dir, now);
  const id = `promoted-${evalCase.traceId}-${verdict.criterionId}`;
  if (existingIds(file).has(id)) return false;

  const promoted: PromotedCase = {
    ...evalCase,
    id,
    provenance: {
      ...(isRecord(evalCase.provenance) ? evalCase.provenance : {}),
      promotedFrom: {
        traceId: evalCase.traceId,
        criterionId: verdict.criterionId,
        verdictId: verdict.id,
        at: now.toISOString(),
      },
    },
  };

  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(promoted)}\n`, 'utf8');
  return true;
}
