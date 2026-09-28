// docs/contracts/j7.md "Promotion"; bead classified-evals-mol-dh8.3.
//
// promoteFailure is called directly as loop.ts's `onVerdict` (RunWatchInput.onVerdict:
// `(verdict: Verdict) => boolean | void`, dh8.2, merged) — synchronous, one verdict at a
// time. That is why this module writes with sync fs calls (appendFileSync/readFileSync,
// same pattern as sampler.ts's inclusion log) rather than the outbox's async files.ts
// helper (appendLines/scanLines): an async promoteFailure could not satisfy onVerdict's
// synchronous contract, and the loop checks `onVerdict(v) === true` without awaiting it.
//
// `evalCase` (the bead's acceptance-criteria text calls this second parameter `trace`) is
// the Case the failing verdict was judged against — the same Case shape extractCases builds
// from a NormalizedTrace, carrying the `traceId` this module needs. loop.ts's onVerdict is
// only ever handed the bare Verdict (no case, no trace); wiring a Case lookup by
// `verdict.caseId` through to this call is the CLI layer's job (watch.ts), not this
// module's — see BUILD report Discoveries.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { Case, Verdict } from '@vetkit/spec';
import type { PromotedCase } from './types.ts';

export interface PromoteFailureOptions {
  /** Defaults to `new Date()`. Lets a caller/test pin the day file and `at` timestamp. */
  readonly now?: Date;
}

function dayFile(dir: string, now: Date): string {
  const iso = now.toISOString().slice(0, 10); // YYYY-MM-DD
  return join(dir, 'pending', `promoted-${iso}.jsonl`);
}

type IdLine = { id?: unknown };

// Best-effort dedupe read: a corrupt line is skipped rather than thrown (this is a dedupe
// check, not the J1 loader's validation chokepoint).
function existingIds(file: string): Set<string> {
  const ids = new Set<string>();
  if (!existsSync(file)) return ids;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line === '') continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === 'object' && parsed !== null) {
        const id = (parsed as IdLine).id;
        if (typeof id === 'string') ids.add(id);
      }
    } catch {
      // Corrupt line: not this function's concern, skip it for dedupe purposes.
    }
  }
  return ids;
}

/**
 * Appends one `PromotedCase` line to `<dir>/pending/promoted-<YYYY-MM-DD>.jsonl` for a
 * failing, `status: 'ok'` verdict, skipping a duplicate id already in that file. Returns
 * whether a line was appended (`false` covers: not a failure, no `evalCase` to promote
 * from, or a duplicate) — never throws.
 */
export function promoteFailure(
  verdict: Verdict,
  evalCase: Case | undefined,
  dir: string,
  options: PromoteFailureOptions = {},
): boolean {
  if (verdict.status !== 'ok' || verdict.pass !== false) return false;
  if (evalCase?.traceId === undefined) return false;

  const now = options.now ?? new Date();
  const file = dayFile(dir, now);
  const id = `promoted-${evalCase.traceId}-${verdict.criterionId}`;
  if (existingIds(file).has(id)) return false;

  const promoted: PromotedCase = {
    ...evalCase,
    id,
    provenance: {
      promotedFrom: {
        traceId: evalCase.traceId,
        criterionId: verdict.criterionId,
        // The loop copies each Verdict (assigning its outbox id) before enqueuing, never
        // surfacing that id back to onVerdict (see module header) — verdict.id is used
        // when a caller has one (e.g. a direct unit test), else a fresh id stands in.
        verdictId: verdict.id ?? randomUUID(),
        at: now.toISOString(),
      },
    },
  };

  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(promoted)}\n`, 'utf8');
  return true;
}
