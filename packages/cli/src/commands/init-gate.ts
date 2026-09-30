// Gate scaffold pieces of `vet init`: the example labels file and the commented generator block.
// Both are plain template files; only tier 2 of the gate needs them.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// src/commands/init-gate.ts and dist/commands/init-gate.js both sit two levels below the package root.
const TEMPLATE_DIR = fileURLToPath(new URL('../../templates/', import.meta.url));

/** The example labels file, beside `evals/labels/` so `loadLabels` never reads it. */
export const GATE_TARGET = {
  path: 'evals/labels.csv.example',
  template: 'labels.csv.example',
} as const;

/** Replaces `{{generator}}` with the commented generator block, on its own lines. */
export function renderGeneratorBlock(configText: string): string {
  const block = readFileSync(`${TEMPLATE_DIR}generator.block.tmpl`, 'utf8').trimEnd();
  return configText.replaceAll('{{generator}}', `\n\n${block}`);
}
