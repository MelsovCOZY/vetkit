// CEV_DIAG=1 diagnostics. loadVetConfig wraps the judge so each doJudge call
// is counted; core's verdict cache sits in front of doJudge, so cache hits never reach it and
// the count is the number of real judge requests. At process exit one line goes to stderr,
// {"diag":{"judge":{"requests":N}}}; stdout (the --json document) is never touched.
// CEV_TRACE_HTTP=1 is an alias for CEV_DIAG=1 on this same vet run counter; it
// also drives a separate, self-contained request count inside exported vitest scorers (see
// packages/export-vitest/src/templates/scorer.ts.tmpl and emit-test.ts), which never goes
// through this module at all — this file's exit-handler line is CLI-process-only and vitest
// workers never surface it (repro).
import type { JudgeV1 } from '@vetkit/spec';

type Env = Readonly<Record<string, string | undefined>>;

const DIAG_ENV = 'CEV_DIAG';
const TRACE_ENV = 'CEV_TRACE_HTTP';

let requests = 0;
let reporting = false;

export function diagEnabled(env: Env): boolean {
  return env[DIAG_ENV] === '1' || env[TRACE_ENV] === '1';
}

/** The same judge, with onRequest called once per doJudge call before it runs. */
export function countJudgeRequests(judge: JudgeV1, onRequest: () => void): JudgeV1 {
  return {
    specVersion: judge.specVersion,
    id: judge.id,
    capabilities: judge.capabilities,
    doJudge: (req) => {
      onRequest();
      return judge.doJudge(req);
    },
  };
}

export function formatDiagLine(count: number): string {
  return `${JSON.stringify({ diag: { judge: { requests: count } } })}\n`;
}

/** Judge requests counted in this process by judges from withJudgeDiag. */
export function judgeRequestCount(): number {
  return requests;
}

/**
 * Counts the judge's requests and, once per process, reports the total on stderr at exit.
 * 'exit' (not 'beforeExit') so the line is also written when the CLI calls process.exit.
 */
export function withJudgeDiag(judge: JudgeV1): JudgeV1 {
  if (!reporting) {
    reporting = true;
    process.once('exit', () => {
      process.stderr.write(formatDiagLine(requests));
    });
  }
  return countJudgeRequests(judge, () => {
    requests += 1;
  });
}
