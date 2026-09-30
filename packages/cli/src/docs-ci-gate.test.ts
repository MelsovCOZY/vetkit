import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CALLS_PER_MINUTE } from '@vetkit/core';
import { JEV_CREDENTIAL_PRIORITY, JEV_PRESETS } from '@vetkit/judge-jev';
import type { Command } from 'commander';
import { beforeAll, describe, expect, it } from 'vitest';
import { createProgram } from './program.ts';
import { ensureCliBuilt } from './test-support/build-cli.js';

const PAGE = fileURLToPath(new URL('../../../docs/ci-gate.md', import.meta.url));
const binPath = fileURLToPath(new URL('../dist/bin.js', import.meta.url));

// Global options every command accepts (program.ts registers them on the root command).
const GLOBAL_FLAGS = ['--json', '--quiet', '--verbose', '--no-color', '--no-env-file'];

const SECTIONS = [
  'Two tiers',
  'Label at least 100 cases',
  'Add a generator',
  'Pin the judge',
  'Validate',
  'Commit the lock',
  'Gate in CI',
  'Rerun offline',
];

let page = '';

function loadPage(): void {
  page = existsSync(PAGE) ? readFileSync(PAGE, 'utf8') : '';
}

function fencedLines(): string[] {
  const blocks = [...page.matchAll(/^```[^\n]*\n([\s\S]*?)^```$/gm)];
  return blocks.flatMap((block) => (block[1] ?? '').split('\n'));
}

// `vet <command> [<subcommand>] ...`: a subcommand is used when the command has one by that name.
function resolve(program: Command, words: readonly string[]): Command | undefined {
  const command = program.commands.find((c) => c.name() === words[0]);
  const sub = command?.commands.find((c) => c.name() === words[1]);
  return sub ?? command;
}

describe('docs/ci-gate.md', () => {
  it('every vet command line uses an existing command and existing flags', () => {
    const program = createProgram();
    const lines = fencedLines().filter((line) => /^vet\s/.test(line));
    expect(lines.length).toBeGreaterThan(5);
    for (const line of lines) {
      const words = line.trim().split(/\s+/).slice(1);
      const command = resolve(program, words);
      expect(command, line).toBeDefined();
      const known = new Set(GLOBAL_FLAGS);
      for (const option of command?.options ?? [])
        if (option.long !== undefined) known.add(option.long);
      for (const flag of line.match(/--[a-z][a-z0-9-]*/g) ?? []) {
        expect(known.has(flag), `${line}: ${flag}`).toBe(true);
      }
    }
  });

  it('the page has the eight sections in order', () => {
    const headings = [...page.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
    expect(headings).toEqual(SECTIONS);
  });

  it('the estimate line in the page matches the validate preflight format', () => {
    const line = fencedLines().find((row) => row.startsWith('estimate:')) ?? '';
    const calls = String(DEFAULT_CALLS_PER_MINUTE);
    const format = new RegExp(
      String.raw`^estimate: \d+ judge calls, (unknown|~\d+) input tokens, cost (unknown|\$\d+\.\d{6}), (unknown|~\d+\.\d) min at ${calls} calls/min \(breakdown: vet estimate --for validate\)$`,
    );
    expect(line).toMatch(format);
    expect(page).toContain('vet estimate --for validate');
  });

  it('the gate lines quoted in the page match what vet run prints', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./commands/run.ts', import.meta.url)),
      'utf8',
    );
    expect(source).toContain('gate: uncalibrated — ');
    expect(page).toContain('gate: uncalibrated — ');
    expect(page).toMatch(/flaky \S+ \(spread \d\.\d\d\)/);
  });

  it('every path it shows exists in the scaffold vet init writes, or is created by a named command', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vetkit-ci-gate-'));
    const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
    for (const preset of JEV_CREDENTIAL_PRIORITY) {
      for (const credential of JEV_PRESETS[preset].credentials) delete env[credential.name];
    }
    delete env['CI'];
    const init = spawnSync(process.execPath, [binPath, 'init'], {
      cwd: dir,
      env,
      encoding: 'utf8',
    });
    expect(init.status).toBe(0);
    const created: Readonly<Record<string, string>> = {
      'evals/labels': 'vet label --from',
      'criteria.lock.json': 'vet validate',
    };
    const shown = new Set(
      (page.match(/(?:evals\/[A-Za-z0-9_./-]*[A-Za-z0-9_-]|criteria\.lock\.json)/g) ?? []).map(
        (path) => path.replace(/\/$/, ''),
      ),
    );
    for (const required of [
      'evals/criteria.yaml',
      'evals/cases',
      'evals/labels',
      'evals/labels.csv.example',
      'criteria.lock.json',
    ]) {
      expect(shown.has(required), required).toBe(true);
    }
    for (const path of shown) {
      const creator = created[path];
      if (creator === undefined) expect(existsSync(join(dir, path)), path).toBe(true);
      else expect(page, path).toContain(creator);
    }
  });

  it('names no vendor host, no raw pass rate claim and no invented flag outside fences', () => {
    expect(page).not.toMatch(/https?:\/\//);
    const prose = page.replace(/^```[^\n]*\n[\s\S]*?^```$/gm, '');
    expect(prose).not.toMatch(/--[a-z]/);
    expect(page).toContain('≥100 labels per criterion with ≥30 pass and ≥30 fail held out');
  });
});

beforeAll(async () => {
  await ensureCliBuilt();
  loadPage();
}, 180_000);
