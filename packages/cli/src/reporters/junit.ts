// JUnit reporter for `vet run` (a reporter, not a sink).
// renderJunit is pure so the GitHub Action and the vitest export can reuse it. One <testsuite>
// per criteria file, one <testcase name="caseId::criterionId"> per verdict. Only ok verdicts
// are pass or fail; every other status is a skip carrying the status (judge
// failures stay separate from incorrect answers). The XML is string-built (no dependency) and
// targets the windyroad JUnit XSD (fixtures/reporters/junit-10.xsd).
import { createHash } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { hostname as osHostname } from 'node:os';
import { basename, dirname, extname, resolve } from 'node:path';
import type { RunEvalsResult, RunVerdict } from '@vetkit/core';
import { InvalidArgumentError, type Command } from 'commander';

export const DEFAULT_JUNIT_PATH = '.vet/junit.xml';

export interface ReporterSpec {
  readonly kind: 'junit';
  /** Output path, resolved against the cwd at write time. */
  readonly path: string;
}

export interface JunitSuiteInput {
  /** The criteria file this suite judged; names the suite. */
  readonly criteriaPath: string;
  readonly result: Pick<RunEvalsResult, 'results' | 'model'>;
}

export interface RenderJunitOptions {
  /** When the run happened; rendered without a timezone, as the XSD requires. */
  readonly timestamp: Date;
  readonly hostname?: string;
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function attrs(values: Record<string, string | number>): string {
  return Object.entries(values)
    .map(([key, value]) => ` ${key}="${escapeXml(String(value))}"`)
    .join('');
}

// Same basename in two criteria files: suffix each with a short hash of its full path.
function suiteNames(paths: readonly string[]): string[] {
  const bases = paths.map((p) => basename(p, extname(p)) || p);
  return bases.map((base, i) => {
    if (bases.indexOf(base) === bases.lastIndexOf(base)) return base;
    const hash = createHash('sha256')
      .update(paths[i] ?? '')
      .digest('hex')
      .slice(0, 7);
    return `${base}-${hash}`;
  });
}

type Outcome = { kind: 'pass' } | { kind: 'failure'; message: string } | { kind: 'skipped' };

function failureMessage(v: RunVerdict): string {
  const parts: string[] = [];
  const answer = v.answer;
  if (answer?.type === 'boolean') parts.push(`probability ${String(answer.probability)}`);
  if (answer?.type === 'choice') parts.push(`choice ${answer.choice}`);
  if (answer?.type === 'score') parts.push(`score ${String(answer.score)}`);
  if (answer !== undefined && answer.type !== 'boolean') {
    parts.push(`confidence ${String(answer.confidence)}`);
  }
  if (v.threshold !== undefined) parts.push(`threshold ${String(v.threshold)}`);
  return parts.length === 0 ? 'failed' : parts.join(', ');
}

function outcome(v: RunVerdict): Outcome {
  if (v.status !== 'ok') return { kind: 'skipped' };
  return v.pass === true ? { kind: 'pass' } : { kind: 'failure', message: failureMessage(v) };
}

// xs:dateTime without timezone or fractional seconds (ISO8601_DATETIME_PATTERN).
function formatTimestamp(date: Date): string {
  return date.toISOString().slice(0, 19);
}

export function renderJunit(
  suites: readonly JunitSuiteInput[],
  options: RenderJunitOptions,
): string {
  const names = suiteNames(suites.map((s) => s.criteriaPath));
  const timestamp = formatTimestamp(options.timestamp);
  const host = options.hostname ?? 'localhost';
  const totals = { tests: 0, failures: 0, skipped: 0 };
  const body = suites.map((input, id) => {
    const name = names[id] ?? input.criteriaPath;
    const outcomes = input.result.results.map((v) => ({ v, o: outcome(v) }));
    const failures = outcomes.filter(({ o }) => o.kind === 'failure').length;
    const skipped = outcomes.filter(({ o }) => o.kind === 'skipped').length;
    totals.tests += outcomes.length;
    totals.failures += failures;
    totals.skipped += skipped;
    const { model } = input.result;
    const props = [
      ['model.requested', model.requested],
      ['model.resolved', model.resolved],
      ['model.transport', model.transport],
      ['model.pinned', String(model.pinned)],
    ]
      .map(([key = '', value = '']) => `      <property${attrs({ name: key, value })}/>`)
      .join('\n');
    const cases = outcomes.map(({ v, o }) => {
      const open = `    <testcase${attrs({ name: `${v.caseId}::${v.criterionId}`, classname: name, time: 0 })}`;
      if (o.kind === 'pass') return `${open}/>`;
      const child =
        o.kind === 'failure'
          ? `<failure${attrs({ message: o.message, type: 'threshold' })}/>`
          : `<skipped${attrs({ message: v.status })}/>`;
      return `${open}>\n      ${child}\n    </testcase>`;
    });
    const suiteAttrs = attrs({
      name,
      timestamp,
      hostname: host,
      tests: outcomes.length,
      failures,
      errors: 0,
      skipped,
      time: 0,
      package: input.criteriaPath,
      id,
    });
    return [
      `  <testsuite${suiteAttrs}>`,
      '    <properties>',
      props,
      '    </properties>',
      ...cases,
      '    <system-out/>',
      '    <system-err/>',
      '  </testsuite>',
    ].join('\n');
  });
  const rootAttrs = attrs({ ...totals, errors: 0 });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    body.length === 0 ? `<testsuites${rootAttrs}/>` : `<testsuites${rootAttrs}>`,
    ...(body.length === 0 ? [] : [...body, '</testsuites>']),
    '',
  ].join('\n');
}

/** Parses `junit` or `junit=<path>`; anything else is a usage error. */
function parseReporterSpec(value: string): ReporterSpec {
  const [kind, ...rest] = value.split('=');
  const path = rest.length === 0 ? DEFAULT_JUNIT_PATH : rest.join('=');
  if (kind !== 'junit' || path === '') {
    throw new InvalidArgumentError(`unknown reporter "${value}" (expected junit or junit=<path>)`);
  }
  return { kind, path };
}

/** Adds `--reporter junit[=path]` to a command; the parsed value lands in opts().reporter. */
export function registerReporterFlag(command: Command): Command {
  return command.option(
    '--reporter <spec>',
    `also write a report: junit[=path] (default path ${DEFAULT_JUNIT_PATH})`,
    parseReporterSpec,
  );
}

export interface WriteReportsOptions {
  readonly cwd: string;
  readonly timestamp?: Date;
  readonly hostname?: string;
}

/**
 * Writes the report the flag asked for (nothing when unset) and returns its absolute path.
 * The file is written to a sibling temp file and renamed, so readers never see a partial
 * document; missing directories are created. Never writes to stdout.
 */
export async function writeReports(
  reporter: ReporterSpec | undefined,
  suites: readonly JunitSuiteInput[],
  options: WriteReportsOptions,
): Promise<string | undefined> {
  if (reporter === undefined) return undefined;
  const target = resolve(options.cwd, reporter.path);
  const xml = renderJunit(suites, {
    timestamp: options.timestamp ?? new Date(),
    hostname: options.hostname ?? (osHostname() || 'localhost'),
  });
  await mkdir(dirname(target), { recursive: true });
  const temp = `${target}.${String(process.pid)}.tmp`;
  try {
    await writeFile(temp, xml, 'utf8');
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  return target;
}
