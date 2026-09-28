import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeParseJson } from '@vetkit/spec';
import { beforeAll, describe, expect, test } from 'vitest';
import { ensureCliBuilt } from '../test-support/build-cli.js';

const binPath = fileURLToPath(new URL('../../dist/bin.js', import.meta.url));
const badDir = fileURLToPath(new URL('../../../../fixtures/lint-bad/', import.meta.url));
const goodFile = fileURLToPath(
  new URL('../../../../fixtures/lint-good/valid.yaml', import.meta.url),
);

beforeAll(async () => {
  await ensureCliBuilt();
}, 180_000);

interface Result {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number | null;
}

function runLint(args: readonly string[], cwd?: string): Result {
  return spawnSync(process.execPath, [binPath, 'lint', ...args], {
    ...(cwd === undefined ? {} : { cwd }),
    encoding: 'utf8',
  });
}

interface LintDoc {
  readonly issues: readonly {
    readonly ruleId: string;
    readonly severity: string;
    readonly criterionId: string;
    readonly path: string;
    readonly message: string;
  }[];
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters
function parseJson<T = unknown>(text: string): T {
  const result = safeParseJson<T>(text, {});
  if (!result.ok) throw result.error;
  return result.value;
}

// Ground truth from core/src/criteria/lint.ts's LINT_RULES: every rule these fixtures name
// is 'error' severity (the 10-file loop).
const ERROR_SEVERITY_FIXTURES = [
  'compound-level.yaml',
  'computation.yaml',
  'contradicts-instruction.yaml',
  'deep-indirection.yaml',
  'double-negative.yaml',
  'escape-missing.yaml',
  'forbidden-word.yaml',
  'inverted-boolean.yaml',
  'negation-pair.yaml',
  'non-atomic.yaml',
];

describe('vet lint', () => {
  test.each(ERROR_SEVERITY_FIXTURES)('%s: an error-severity issue exits 1', (name) => {
    const result = runLint([`${badDir}${name}`, '--json']);
    expect(result.status).toBe(1);
    const doc = parseJson<LintDoc>(result.stdout);
    expect(doc.issues.length).toBeGreaterThan(0);
    expect(doc.issues.some((issue) => issue.severity === 'error')).toBe(true);
    for (const issue of doc.issues) {
      expect(issue.ruleId.length).toBeGreaterThan(0);
      expect(issue.criterionId.length).toBeGreaterThan(0);
      expect(issue.path.length).toBeGreaterThan(0);
      expect(issue.message.length).toBeGreaterThan(0);
    }
  });

  test('a clean criteria.yaml exits 0 with no issues', () => {
    const result = runLint([goodFile, '--json']);
    expect(result.status).toBe(0);
    expect(parseJson(result.stdout)).toEqual({ issues: [] });
  });

  test('human output lists the rule id, criterion id, path and message', () => {
    const result = runLint([`${badDir}escape-missing.yaml`]);
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/ESCAPE_MISSING/);
    expect(result.stdout).toMatch(/tone/);
  });

  test('the default path is evals/criteria.yaml, relative to cwd', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vetkit-lint-'));
    mkdirSync(join(dir, 'evals'), { recursive: true });
    writeFileSync(
      join(dir, 'evals', 'criteria.yaml'),
      'criteria:\n  - id: x\n    type: boolean\n    instructions: Does the reply exist?\n    escape: The reply is empty.\n    polarity: pass_when_true\n    channel: outcome\n    provenance:\n      traceIds: []\n',
    );
    const result = runLint(['--json'], dir);
    expect(result.status).toBe(0);
    expect(parseJson(result.stdout)).toEqual({ issues: [] });
  });
});
