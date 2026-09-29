// Error-analysis-first step: one generator call over a seeded sample of at most 20 traces
// proposes named failure modes, each tied to trace ids that exist in the input. When that
// yields fewer than MIN_FAILURE_MODES and the corpus has unsampled traces, one top-up call
// over the next 20 traces asks for further modes, naming the ones already found.
import type { GeneratorV1, NormalizedTrace } from '@vetkit/spec';
import type { Events } from '../events.ts';
import {
  FAILURE_MODES_PROMPT,
  FAILURE_MODES_SCHEMA,
  generateStructured,
  MIN_FAILURE_MODES,
} from './prompts.ts';

export { MIN_FAILURE_MODES };

export interface FailureMode {
  readonly name: string;
  readonly description: string;
  readonly exampleTraceIds: readonly string[];
}

export interface ProposeFailureModesInput {
  readonly generator: GeneratorV1;
  readonly traces: readonly NormalizedTrace[];
  readonly signal?: AbortSignal;
  readonly events?: Events;
  /** Seed for the trace sample shuffle (default 0). */
  readonly seed?: number;
}

const MAX_DIGEST_TRACES = 20;
const MAX_TRACE_CHARS = 2000;
const MIN_TRACES = 5;

// mulberry32: small, deterministic, good enough for a reproducible sample.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(traces: readonly NormalizedTrace[], seed: number): NormalizedTrace[] {
  const out = [...traces];
  const next = rng(seed);
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    const tmp = out[i];
    const other = out[j];
    if (tmp === undefined || other === undefined) continue;
    out[i] = other;
    out[j] = tmp;
  }
  return out;
}

function renderTrace(trace: NormalizedTrace): string {
  const lines: string[] = [];
  for (const message of trace.messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const text = message.parts
      .map((part) => (part.type === 'text' ? part.content : ''))
      .filter((content) => content !== '')
      .join('\n');
    if (text !== '') lines.push(`${message.role}: ${text}`);
  }
  const body = lines.join('\n');
  return `### trace ${trace.traceId}\n${body.slice(-MAX_TRACE_CHARS)}`;
}

interface RawOutput {
  failureModes: { name: string; description: string; exampleTraceIds: string[] }[];
}

export async function proposeFailureModes(input: ProposeFailureModesInput): Promise<FailureMode[]> {
  const { generator, traces, signal, events } = input;
  if (traces.length < MIN_TRACES) {
    events?.diag('warn', 'FEW_TRACES', 'fewer than 5 traces: failure modes may be thin', {
      traces: traces.length,
    });
  }
  const shuffled = shuffle(traces, input.seed ?? 0);
  const known = new Set(traces.map((t) => t.traceId));

  const seen = new Set<string>();
  const modes: FailureMode[] = [];
  let duplicates = 0;
  let droppedIds = 0;
  const ask = async (digest: readonly NormalizedTrace[]): Promise<void> => {
    const found =
      modes.length === 0
        ? ''
        : `Failure modes already found (do not repeat them):\n${modes
            .map((m) => `- ${m.name}: ${m.description.replaceAll('\n', ' ')}`)
            .join('\n')}\n\n`;
    const { value } = await generateStructured<RawOutput>(generator, {
      system: FAILURE_MODES_PROMPT,
      prompt: found + digest.map(renderTrace).join('\n\n'),
      name: 'failure_modes',
      schema: FAILURE_MODES_SCHEMA,
      ...(signal === undefined ? {} : { signal }),
    });
    const digestIds = digest.map((t) => t.traceId);
    for (const mode of value.failureModes) {
      if (seen.has(mode.name)) {
        duplicates += 1;
        continue;
      }
      seen.add(mode.name);
      const ids = [...new Set(mode.exampleTraceIds)].filter((id) => known.has(id));
      droppedIds += mode.exampleTraceIds.length - ids.length;
      modes.push({
        name: mode.name,
        description: mode.description,
        exampleTraceIds: ids.length > 0 ? ids : digestIds,
      });
    }
  };

  await ask(shuffled.slice(0, MAX_DIGEST_TRACES));
  const rest = shuffled.slice(MAX_DIGEST_TRACES, 2 * MAX_DIGEST_TRACES);
  if (modes.length < MIN_FAILURE_MODES && rest.length > 0) {
    const before = modes.length;
    await ask(rest);
    events?.diag(
      'info',
      'FAILURE_MODE_TOP_UP',
      'asked for more failure modes on unsampled traces',
      {
        before,
        after: modes.length,
      },
    );
  }
  if (duplicates > 0) {
    events?.diag('info', 'DUPLICATE_FAILURE_MODE', 'kept the first of duplicate failure modes', {
      duplicates,
    });
  }
  if (droppedIds > 0) {
    events?.diag('info', 'UNKNOWN_TRACE_ID', 'dropped example trace ids not in the input', {
      droppedIds,
    });
  }
  return modes;
}
