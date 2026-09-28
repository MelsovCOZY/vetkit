// `vet export` (bead mol-aq4.3). Exercises the CLI plumbing only (target resolution, config/
// criteria/cases loading, --require-lock, --json output) against a fake exporter registered
// through registerExporter — never the real @vetkit/export-vitest exporter, which is covered
// directly by packages/export-vitest/src/emit-test.test.ts.
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CEV_ERROR_CODES,
  safeParseJson,
  VetError,
  type Case,
  type Criterion,
  type ExporterV1,
} from '@vetkit/spec';
import { Command } from 'commander';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { handleError } from '../errors.ts';
import { configureOutput } from '../output.ts';
import { registerExport, registerExporter, type ExportDeps } from './export.ts';

const CRITERIA_YAML = `criteria:
  - id: helpful
    type: boolean
    instructions: Is the reply helpful?
    escape: not answerable
    polarity: pass_when_true
    channel: quality
    provenance:
      traceIds: []
`;

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'vetkit-export-'));
  await mkdir(join(root, 'evals', 'cases'), { recursive: true });
  await writeFile(join(root, 'evals', 'criteria.yaml'), CRITERIA_YAML);
  await writeFile(
    join(root, 'evals', 'cases', 'cases.jsonl'),
    `${JSON.stringify({ id: 'c1', input: { state: 'hi' }, provenance: null, tags: [] })}\n`,
  );
  return root;
}

// safeParseJson(text, schema) is the one JSON.parse chokepoint under packages/*/src
// (packages/spec/src/json.ts); `{}` is the permissive "any JSON value" schema.
function parseJson(text: string): unknown {
  const result = safeParseJson<unknown>(text, {});
  if (!result.ok) throw result.error;
  return result.value;
}

function depsFor(root: string): ExportDeps {
  return { loadConfig: () => Promise.resolve({ rootDir: root, warnings: [] }) };
}

function fakeExporter(id: string, files: string[] = ['fake.evals.test.ts']): ExporterV1 {
  return {
    specVersion: 'v1',
    id,
    doExport: (_input: { criteria: Criterion[]; cases: Case[]; lock: unknown; outDir: string }) =>
      Promise.resolve({ files }),
  };
}

let stdout: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  stdout = [];
});

async function vet(args: readonly string[], deps: ExportDeps): Promise<void> {
  configureOutput({ json: true, quiet: true });
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  const program = new Command();
  program.exitOverride().option('--json');
  registerExport(program, deps);
  try {
    await program.parseAsync(['node', 'vet', '--json', ...args]);
  } finally {
    spy.mockRestore();
  }
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the command to reject');
}

function exitCodeOf(error: unknown): number {
  const sink = { write: () => true };
  let code = -1;
  try {
    handleError(error, {
      json: false,
      verbose: false,
      strict: false,
      stdout: sink,
      stderr: sink,
      exit: (c: number) => {
        code = c;
        throw new Error('exit');
      },
    });
  } catch {
    // handleError's exit callback threw to unwind; that's expected.
  }
  return code;
}

describe('vet export', () => {
  test('success: resolves the fake exporter, calls doExport, prints {files} with --json, exit 0', async () => {
    const root = await project();
    registerExporter('fake-success', fakeExporter('fake-success', ['out/fake.evals.test.ts']));
    await vet(['export', '--to', 'fake-success'], depsFor(root));
    expect(process.exitCode ?? 0).toBe(0);
    const doc = parseJson(stdout.join(''));
    expect(doc).toMatchObject({ files: ['out/fake.evals.test.ts'] });
  });

  test('--to nope exits 2 with EXPORT_TARGET_UNKNOWN listing the registered ids', async () => {
    const root = await project();
    registerExporter('fake-listed', fakeExporter('fake-listed'));
    const error = await rejection(vet(['export', '--to', 'nope'], depsFor(root)));
    expect(exitCodeOf(error)).toBe(2);
    if (!VetError.isInstance(error)) throw new Error('expected a VetError');
    expect(error.code).toBe(CEV_ERROR_CODES.EXPORT_TARGET_UNKNOWN);
    expect(error.message).toContain('fake-listed');
  });

  test('missing lock with --require-lock exits 2 with EXPORT_NO_LOCK', async () => {
    const root = await project();
    registerExporter('fake-lock', fakeExporter('fake-lock'));
    const error = await rejection(
      vet(['export', '--to', 'fake-lock', '--require-lock'], depsFor(root)),
    );
    expect(exitCodeOf(error)).toBe(2);
    if (!VetError.isInstance(error)) throw new Error('expected a VetError');
    expect(error.code).toBe(CEV_ERROR_CODES.EXPORT_NO_LOCK);
  });
});
