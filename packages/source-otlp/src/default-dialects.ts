// DEFAULT_DIALECT_ORDER (bead mol-pij.11): the five merged dialect modules (pij.3-6), imported by
// fixed path in the Langfuse cascade order — gen_ai (latest), gen_ai legacy, OpenInference,
// OpenLLMetry, Vercel. otlpSource() (src/index.ts) falls back to this list only when
// opts.dialects is undefined; an explicit [] still means "detect nothing".

import { genAiDialect, genAiLegacyDialect } from './dialects/gen-ai/index.ts';
import { openinferenceDialect } from './dialects/openinference/index.ts';
import { openllmetryDialect } from './dialects/openllmetry/index.ts';
import { vercelDialect } from './dialects/vercel/index.ts';
import type { DialectV1 } from './normalize/dialect.ts';

export const DEFAULT_DIALECT_ORDER: readonly DialectV1[] = [
  genAiDialect,
  genAiLegacyDialect,
  openinferenceDialect,
  openllmetryDialect,
  vercelDialect,
];
