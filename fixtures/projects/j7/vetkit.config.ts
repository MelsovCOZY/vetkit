// Fixture project for the J7 gate (scripts/smoke-j7.sh, e2e/j7.e2e.test.ts). Judge: the REAL
// Jev judge through the Vercel AI Gateway transport (AI_GATEWAY_API_KEY from the environment).
// Sinks: `otel` (the collector at J7_COLLECTOR_ENDPOINT, default the J6 gate's mapped port) and
// `flaky`, a fake sink used by the AC2 step only: VETKIT_FIXTURE_REJECT=<n> makes it reject the
// first n items with a retryable rejection, then accept everything (log: VETKIT_FIXTURE_SINK_LOG).
import { appendFileSync } from 'node:fs';

let rejectLeft = Number(process.env['VETKIT_FIXTURE_REJECT'] ?? '0');
const logPath = process.env['VETKIT_FIXTURE_SINK_LOG'];

const flaky = {
  specVersion: 'v1' as const,
  id: 'flaky',
  capabilities: { batch: 50, idempotent: true },
  doWrite(batch: readonly { id?: string }[]) {
    const accepted: string[] = [];
    const rejected: { id: string; reason: string; retryable: boolean }[] = [];
    for (const verdict of batch) {
      const id = verdict.id ?? '';
      if (rejectLeft > 0) {
        rejectLeft -= 1;
        rejected.push({ id, reason: 'forced rejection', retryable: true });
      } else {
        accepted.push(id);
      }
    }
    if (logPath !== undefined) {
      appendFileSync(
        logPath,
        `${JSON.stringify({ sent: batch.length, accepted: accepted.length, rejected: rejected.length })}\n`,
      );
    }
    return Promise.resolve({ accepted, rejected });
  },
};

export default {
  judge: {
    kind: 'typesafe-compatible',
    preset: 'vercel',
    apiKeyEnv: 'AI_GATEWAY_API_KEY',
    providerOptions: { gateway: { zeroDataRetention: true, only: ['typesafe-ai'] } },
  },
  sinks: [
    { kind: 'otel', endpoint: process.env['J7_COLLECTOR_ENDPOINT'] ?? 'http://127.0.0.1:4320' },
    flaky,
  ],
  thresholds: { default: 0.5, perCriterion: {} },
  watch: { sampleRate: 0.1 },
};
