// Exit-code decision and gate policy: `vet run --gate` calls evaluateGate.
// Exit codes: 0 all gated verdicts pass, 1 any gated verdict fails or is unscored, 2 the gate refuses (no lock, uncalibrated gated criterion, unpinned transport),
// 130 aborted. Verdicts with gated:false (score criteria, uncalibrated languages) never count.
import type { Lock, Verdict } from '@vetkit/spec';
import { LOCK_FILE, lockEntryGateable } from './validate/lock.ts';

export interface GatePolicy {
  /** Minimum pass rate (0..1) over counted verdicts; absent means every one must pass. */
  readonly minPass?: number;
  readonly requireCalibrated: boolean;
  readonly allowUnpinned: boolean;
}

export type ExitCode = 0 | 1 | 2 | 3 | 130;

export interface DecideExitInput {
  readonly verdicts: readonly Verdict[];
  readonly aborted?: boolean;
  readonly minPass?: number;
}

function resultExit(verdicts: readonly Verdict[], minPass: number | undefined): 0 | 1 {
  // not_applicable (escape, missing reference) is neither pass nor fail; unscored is never a pass.
  const counted = verdicts.filter((v) => v.gated !== false && v.status !== 'not_applicable');
  if (counted.length === 0) return 0;
  const passed = counted.filter((v) => v.status === 'ok' && v.pass === true).length;
  if (minPass === undefined) return passed === counted.length ? 0 : 1;
  return passed / counted.length >= minPass ? 0 : 1;
}

export function decideExit(input: DecideExitInput): 0 | 1 | 130 {
  if (input.aborted === true) return 130;
  return resultExit(input.verdicts, input.minPass);
}

export interface EvaluateGateInput {
  readonly verdicts: readonly Verdict[];
  readonly lock: Lock | null;
  readonly policy: GatePolicy;
}

export interface GateResult {
  readonly exitCode: 0 | 1 | 2;
  readonly reasons: string[];
}

export function evaluateGate(input: EvaluateGateInput): GateResult {
  const { lock, policy } = input;
  if (lock === null) {
    return {
      exitCode: 2,
      reasons: [
        `no lock file: ${LOCK_FILE} not found; the gate refuses to run on uncalibrated thresholds (run \`vet validate\`)`,
      ],
    };
  }

  const reasons: string[] = [];
  if (!policy.allowUnpinned) {
    const unpinned = new Set<string>();
    if (!lock.model.pinned) unpinned.add(lock.model.transport);
    for (const v of input.verdicts) if (!v.model.pinned) unpinned.add(v.model.transport);
    for (const transport of unpinned) {
      reasons.push(`transport '${transport}' is unpinned (pass allowUnpinned to gate anyway)`);
    }
  }
  // A verdict served by another model than the lock's is not what was calibrated. Code-graded
  // verdicts never reach a judge; an empty resolved id means nothing was served.
  const servedIds = new Set<string>();
  for (const v of input.verdicts) {
    if (v.gated === false || v.model.transport === 'code' || v.model.resolved === '') continue;
    if (v.model.resolved !== lock.model.resolved) servedIds.add(v.model.resolved);
  }
  for (const id of [...servedIds].toSorted()) {
    reasons.push(
      `served model '${id}' differs from the lock's '${lock.model.resolved}' (run \`vet validate\` against the current judge)`,
    );
  }
  if (policy.requireCalibrated) {
    const gated = new Set(
      input.verdicts.filter((v) => v.gated !== false).map((v) => v.criterionId),
    );
    for (const id of gated) {
      if (!lockEntryGateable(lock.criteria[id], policy.allowUnpinned)) {
        reasons.push(`criterion '${id}' is not calibrated in ${LOCK_FILE}`);
      }
    }
  }
  if (reasons.length > 0) return { exitCode: 2, reasons };

  return { exitCode: resultExit(input.verdicts, policy.minPass), reasons };
}
