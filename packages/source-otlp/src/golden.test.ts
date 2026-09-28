// Golden fixtures + cross-dialect parity test (bead mol-pij.9): the corpus and the single test
// that prove root acceptance J5 "golden diff 0 across five dialects", independent of the CLI.
// Six hand-authored OTLP/JSON fixtures (fixtures/otlp/) each carry the same two-turn conversation
// (system + user + assistant tool call + tool response + final assistant answer, 120/45 usage
// tokens) encoded in one dialect's own attribute convention, over the same span topology
// (root -> llm -> tool -> llm); fixtures/otlp/golden/ holds the expected normalized output this
// test deep-equals against.
//
// This corpus's shared conversation uses only `text` MessageParts, never `tool_call`/
// `tool_call_response` (see mol-pij.9 BUILD report Discoveries) — genAiLegacyDialect,
// openinference and vercel could not yet map their native tool-call attributes to those parts.
// That gap is bead mol-pij.14: a second corpus below (TOOLCALL_DIALECT_FILES) carries the same
// conversation with a real tool_call/tool_call_response round trip, proving that parity too.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  safeParseJson,
  traceSchema,
  type JsonSchema,
  type NormalizedTrace,
  type ParseResult,
} from '@vetkit/spec';
import { otlpSource } from './index.ts';

const FIXTURES_DIR = fileURLToPath(new URL('../../../fixtures/otlp/', import.meta.url));

const DIALECT_FILES = [
  'gen_ai-latest',
  'gen_ai-legacy',
  'openinference',
  'openllmetry',
  'vercel',
] as const;

// pij.14: a second corpus, one tool-call conversation (assistant tool_call -> tool
// tool_call_response -> final assistant text) per dialect, alongside the text-only corpus above
// (kept as-is). Same shared tokens.json (120/45/165) since the token attributes are unchanged.
const TOOLCALL_DIALECT_FILES = [
  'gen_ai-latest-toolcall',
  'gen_ai-legacy-toolcall',
  'openinference-toolcall',
  'openllmetry-toolcall',
  'vercel-toolcall',
] as const;

interface ProjectedSpan {
  name: string;
  kind: string | undefined;
}

interface Projected {
  messages: NormalizedTrace['messages'];
  spans: ProjectedSpan[];
  tokens: NormalizedTrace['tokens'];
}

interface GoldenCase {
  file: string;
  messages: NormalizedTrace['messages'];
  spans: ProjectedSpan[];
}

// safeParseJson (packages/spec/src/json.ts) is the one JSON.parse chokepoint under packages/*/src
// (scripts/ban-raw-json-parse.sh); this test's own reads of fixture/golden JSON go through it too.
const FIXTURE_FILE_SCHEMA: JsonSchema = {
  type: 'object',
  properties: { _source: {} },
  additionalProperties: true,
};

const GOLDEN_CASE_SCHEMA: JsonSchema = {
  $defs: traceSchema.$defs,
  type: 'object',
  properties: {
    file: { type: 'string' },
    messages: { type: 'array', items: { $ref: '#/$defs/Message' } },
    spans: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, kind: { type: 'string' } },
        required: ['name', 'kind'],
      },
    },
  },
  required: ['file', 'messages', 'spans'],
};

const TOKENS_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    input: { type: 'number' },
    output: { type: 'number' },
    total: { type: 'number' },
  },
};

function unwrap<T>(result: ParseResult<T>): T {
  if (!result.ok) {
    throw new Error(`golden.test.ts fixture/golden parse failure: ${result.error.message}`);
  }
  return result.value;
}

// Golden output shape (bead design): NormalizedTrace projected to {messages, spans:[{name,kind}],
// tokens} -- traceId and every span/message id are excluded (acceptance criteria "ids excluded").
function project(trace: NormalizedTrace): Projected {
  return {
    messages: trace.messages,
    spans: trace.spans.map((s) => ({ name: s.name, kind: s.kind })),
    tokens: trace.tokens,
  };
}

async function readGoldenCases(fileName: string): Promise<GoldenCase[]> {
  const text = await readFile(join(FIXTURES_DIR, 'golden', fileName), 'utf8');
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => unwrap(safeParseJson<GoldenCase>(line, GOLDEN_CASE_SCHEMA)));
}

async function readTokensGolden(fileName: string): Promise<NormalizedTrace['tokens']> {
  const text = await readFile(join(FIXTURES_DIR, 'golden', fileName), 'utf8');
  return unwrap(safeParseJson<NormalizedTrace['tokens']>(text, TOKENS_SCHEMA));
}

async function normalizeOneTrace(file: string): Promise<NormalizedTrace> {
  const source = otlpSource({ files: [join(FIXTURES_DIR, `${file}.json`)] });
  const traces: NormalizedTrace[] = [];
  for await (const trace of source.doRead({})) traces.push(trace);
  expect(traces).toHaveLength(1);
  const [trace] = traces;
  if (trace === undefined) throw new Error('unreachable: length asserted above');
  return trace;
}

describe('fixture authorship is traceable', () => {
  test('every fixtures/otlp/*.json file has a non-empty top-level _source field', async () => {
    for (const file of [...DIALECT_FILES, ...TOOLCALL_DIALECT_FILES, 'incomplete']) {
      const text = await readFile(join(FIXTURES_DIR, `${file}.json`), 'utf8');
      const raw = unwrap(safeParseJson<Record<string, unknown>>(text, FIXTURE_FILE_SCHEMA));
      const source = raw['_source'];
      expect(typeof source).toBe('string');
      expect(typeof source === 'string' && source.length > 0).toBe(true);
    }
  });
});

// Shared by both the text-only and the tool-call golden describes below: normalizes every file
// in `files`, asserts messages/tokens are identical across all of them (golden diff 0), and
// checks each file's full projection against its own per-file golden case.
async function assertCrossDialectParity(
  files: readonly string[],
  casesFileName: string,
  tokensFileName: string,
): Promise<void> {
  const [goldenCases, tokensGolden] = await Promise.all([
    readGoldenCases(casesFileName),
    readTokensGolden(tokensFileName),
  ]);

  const projected = new Map<string, Projected>();
  for (const file of files) {
    const trace = await normalizeOneTrace(file);
    projected.set(file, project(trace));
  }

  const [firstFile, ...restFiles] = files;
  if (firstFile === undefined) throw new Error('unreachable: files is non-empty');
  const first = projected.get(firstFile);
  if (first === undefined) throw new Error('unreachable');

  // Cross-dialect parity: the same conversation normalizes to the same messages and the same
  // token totals no matter which dialect encoded it (golden diff 0 across five dialects).
  for (const file of restFiles) {
    const entry = projected.get(file);
    expect(entry?.messages).toEqual(first.messages);
    expect(entry?.tokens).toEqual(first.tokens);
  }
  for (const file of files) {
    expect(projected.get(file)?.tokens).toEqual(tokensGolden);
  }

  // Per-file golden: spans/kinds may legitimately differ by dialect (e.g. only openllmetry
  // maps a tool span to Span.kind 'tool' via its spanKind hook), so each file is checked
  // against its own golden entry rather than against the other four files.
  for (const file of files) {
    const golden = goldenCases.find((c) => c.file === file);
    expect(golden, `no golden case for ${file}`).toBeDefined();
    if (golden === undefined) continue;
    expect(projected.get(file)).toEqual({
      messages: golden.messages,
      spans: golden.spans,
      tokens: tokensGolden,
    });
  }
}

describe('golden fixtures: cross-dialect parity (root acceptance J5)', () => {
  test('all five dialect fixtures normalize to identical messages and tokens, and match their own golden spans/kinds', async () => {
    await assertCrossDialectParity(DIALECT_FILES, 'cases.jsonl', 'tokens.json');
  });
});

// pij.14: the same parity property, proven on a conversation that actually exercises tool_call /
// tool_call_response parts (the text-only corpus above never does — see its DEVIATION note,
// since resolved). Ids are each dialect's own native id (e.g. "call_1"), normalised by
// normalizeTrace to tool_call_1 identically for all five, so the golden messages below use that
// normalised id, not any dialect's native one.
describe('golden fixtures: cross-dialect parity for a tool-call conversation (root acceptance J5, mol-pij.14)', () => {
  test('all five dialect fixtures normalize a tool_call/tool_call_response round trip identically', async () => {
    await assertCrossDialectParity(TOOLCALL_DIALECT_FILES, 'cases-toolcall.jsonl', 'tokens.json');
  });
});

describe('incomplete.json: four traces, four distinct completeness statuses', () => {
  test('content not captured, truncated (length), truncated (dropped), missing parent', async () => {
    const source = otlpSource({ files: [join(FIXTURES_DIR, 'incomplete.json')] });
    const traces: NormalizedTrace[] = [];
    for await (const trace of source.doRead({})) traces.push(trace);
    expect(traces).toHaveLength(4);

    const [contentNotCaptured, truncatedLength, truncatedDropped, missingParent] = traces;

    expect(contentNotCaptured?.completeness).toEqual({
      contentCaptured: false,
      truncated: false,
      missingParents: false,
    });
    expect(truncatedLength?.completeness).toEqual({
      contentCaptured: true,
      truncated: true,
      missingParents: false,
    });
    expect(truncatedDropped?.completeness).toEqual({
      contentCaptured: true,
      truncated: true,
      missingParents: false,
    });
    expect(missingParent?.completeness).toEqual({
      contentCaptured: true,
      truncated: false,
      missingParents: true,
    });
  });
});
