import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Contributors get lefthook's own hooks via `bun run hooks:install`; nothing tracked
// depends on the bd-managed .beads/hooks chain. All git state lives in throwaway temp
// repos, never this checkout's .git/config.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INSTALL = join(ROOT, 'scripts', 'install-hooks.ts');

function git(cwd: string, ...args: string[]): { status: number | null; out: string } {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  return { status: r.status, out: (r.stdout + r.stderr).trim() };
}

function makeRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'vetkit-hooks-')));
  git(dir, 'init', '-q');
  writeFileSync(
    join(dir, 'lefthook.yml'),
    'pre-commit:\n  commands:\n    noop:\n      run: echo ok\n',
  );
  return dir;
}

const BD_MARKER = '# --- BEGIN BEADS INTEGRATION';
const CHAIN_BEGIN = '# --- BEGIN LEFTHOOK CHAIN';

// A checkout the way bd leaves it: .beads/, core.hooksPath, and a marked pre-commit shim.
function bdCheckout(dir: string): string {
  const hooks = join(dir, '.beads', 'hooks');
  mkdirSync(hooks, { recursive: true });
  git(dir, 'config', 'core.hooksPath', '.beads/hooks');
  writeFileSync(
    join(hooks, 'pre-commit'),
    `#!/usr/bin/env sh\n${BD_MARKER} v1 ---\necho bd-ran >> "$HOOK_LOG"\n# --- END BEADS INTEGRATION v1 ---\n`,
    { mode: 0o755 },
  );
  return hooks;
}

// Commits with a recording stand-in for bun, so the hooks' real chain is exercised.
function commitWithFakeBun(dir: string): string {
  const bin = join(dir, 'fakebin');
  const log = join(dir, 'hook.log');
  mkdirSync(bin);
  writeFileSync(join(bin, 'bun'), '#!/bin/sh\necho "$@" >> "$HOOK_LOG"\n', { mode: 0o755 });
  writeFileSync(join(dir, 'f.txt'), 'x');
  git(dir, 'add', 'f.txt');
  const r = spawnSync(
    'git',
    ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'msg'],
    {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOOK_LOG: log },
    },
  );
  expect(r.status, r.stderr + r.stdout).toBe(0);
  return readFileSync(log, 'utf8');
}

// Commits with a bun stand-in that prints a line and fails, like a lefthook that found problems.
function commitWithFailingBun(dir: string) {
  const bin = join(dir, 'fakebin');
  const log = join(dir, 'hook.log');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'bun'),
    '#!/bin/sh\necho "$@" >> "$HOOK_LOG"\necho lefthook-output-visible\nexit 1\n',
    { mode: 0o755 },
  );
  writeFileSync(join(dir, 'f.txt'), 'x');
  git(dir, 'add', 'f.txt');
  const r = spawnSync(
    'git',
    ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'msg'],
    {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOOK_LOG: log },
    },
  );
  return { status: r.status, output: r.stderr + r.stdout, log: readFileSync(log, 'utf8') };
}

const OLD_TAIL = `
# Advisory only (root DECISION resolving OPEN-3): lefthook is never installed via
# \`lefthook install\`, so it is invoked here via \`bunx\` instead.
if command -v bun >/dev/null 2>&1; then
  bun x lefthook run pre-commit --no-auto-install "$@"
else
  echo >&2 "beads: bun not found, skipping lefthook run pre-commit (CI is the gate)"
fi
exit 0
`;

function runInstall(cwd: string) {
  return spawnSync('bun', [INSTALL], { cwd, encoding: 'utf8' });
}

function withRepo(fn: (dir: string) => void): void {
  const dir = makeRepo();
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('contributor hooks: lefthook installed directly', () => {
  it('installs a pre-commit hook with no .beads path and no hooksPath warning', () => {
    withRepo((dir) => {
      const run = runInstall(dir);
      expect(run.status, run.stderr + run.stdout).toBe(0);
      expect(run.stderr + run.stdout).not.toMatch(/core\.hooksPath/);

      const hook = join(dir, '.git', 'hooks', 'pre-commit');
      expect(existsSync(hook)).toBe(true);
      expect(readFileSync(hook, 'utf8')).not.toContain('.beads');
      expect(readFileSync(hook, 'utf8')).toContain('lefthook');
      expect(git(dir, 'config', '--local', '--get', 'core.hooksPath').out).toBe('');
    });
  });

  it('unsets a stale core.hooksPath that points into .beads/ when no .beads dir exists', () => {
    withRepo((dir) => {
      git(dir, 'config', 'core.hooksPath', '.beads/hooks');
      const run = runInstall(dir);
      expect(run.status, run.stderr + run.stdout).toBe(0);
      expect(git(dir, 'config', '--local', '--get', 'core.hooksPath').out).toBe('');
      expect(existsSync(join(dir, '.git', 'hooks', 'pre-commit'))).toBe(true);
    });
  });

  it('still installs plain lefthook hooks when no .beads dir exists', () => {
    withRepo((dir) => {
      const run = runInstall(dir);
      expect(run.status, run.stderr + run.stdout).toBe(0);
      expect(readFileSync(join(dir, '.git', 'hooks', 'pre-commit'), 'utf8')).toContain('lefthook');
    });
  });

  it('chains lefthook into bd-managed hooks and runs both on commit', () => {
    withRepo((dir) => {
      const hooks = bdCheckout(dir);
      const run = runInstall(dir);
      expect(run.status, run.stderr + run.stdout).toBe(0);
      expect(git(dir, 'config', '--local', '--get', 'core.hooksPath').out).toBe('.beads/hooks');
      expect(existsSync(join(dir, '.git', 'hooks', 'pre-commit'))).toBe(false);

      for (const name of ['pre-commit', 'commit-msg']) {
        expect(statSync(join(hooks, name)).mode & 0o111, name).not.toBe(0);
      }
      expect(readFileSync(join(hooks, 'pre-commit'), 'utf8')).toContain(BD_MARKER);

      const log = commitWithFakeBun(dir);
      expect(log).toContain('bd-ran');
      expect(log).toContain('x lefthook run pre-commit');
      expect(log).toContain('x lefthook run commit-msg');
    });
  });

  it('never fails the commit on lefthook failure, and shows its output', () => {
    withRepo((dir) => {
      bdCheckout(dir);
      runInstall(dir);
      const r = commitWithFailingBun(dir);
      expect(r.status, r.output).toBe(0);
      expect(r.output).toContain('lefthook-output-visible');
      expect(r.log).toContain('x lefthook run pre-commit');
      expect(r.log).toContain('x lefthook run commit-msg');
    });
  });

  it('replaces an old hand-written advisory tail so lefthook runs exactly once', () => {
    withRepo((dir) => {
      const hooks = bdCheckout(dir);
      const file = join(hooks, 'pre-commit');
      writeFileSync(file, readFileSync(file, 'utf8') + OLD_TAIL);
      const run = runInstall(dir);
      expect(run.status, run.stderr + run.stdout).toBe(0);
      const text = readFileSync(file, 'utf8');
      expect(text.split('bun x lefthook run pre-commit').length - 1).toBe(1);
      expect(text).not.toContain('Advisory only (root DECISION');
      expect(text).toContain(BD_MARKER);
      const r = commitWithFailingBun(dir);
      expect(r.status, r.output).toBe(0);
      expect(r.log.split('x lefthook run pre-commit').length - 1).toBe(1);
    });
  });

  it('is idempotent: a rerun adds no second chain block', () => {
    withRepo((dir) => {
      const hooks = bdCheckout(dir);
      runInstall(dir);
      const before = ['pre-commit', 'commit-msg'].map((n) => readFileSync(join(hooks, n), 'utf8'));
      const run = runInstall(dir);
      expect(run.status, run.stderr + run.stdout).toBe(0);
      const after = ['pre-commit', 'commit-msg'].map((n) => readFileSync(join(hooks, n), 'utf8'));
      expect(after).toEqual(before);
      for (const text of after) expect(text.split(CHAIN_BEGIN).length - 1).toBe(1);
    });
  });

  it('keeps the chain when bd rewrites only its own marked section', () => {
    withRepo((dir) => {
      const hooks = bdCheckout(dir);
      runInstall(dir);
      const file = join(hooks, 'pre-commit');
      writeFileSync(file, readFileSync(file, 'utf8').replace('bd-ran', 'bd-ran-v2'));
      const run = runInstall(dir);
      expect(run.status, run.stderr + run.stdout).toBe(0);
      const text = readFileSync(file, 'utf8');
      expect(text).toContain('bd-ran-v2');
      expect(text.split(CHAIN_BEGIN).length - 1).toBe(1);
    });
  });

  it('wires hooks:install to the install script', () => {
    const text = readFileSync(join(ROOT, 'package.json'), 'utf8');
    expect(text).toContain('"hooks:install": "bun scripts/install-hooks.ts"');
  });
});

describe('agent tooling is untracked', () => {
  it('tracks nothing under .beads, graphify-out or .codex', () => {
    const r = git(ROOT, 'ls-files', '.beads', 'graphify-out', '.codex');
    expect(r.out).toBe('');
  });

  it('ignores .beads/ and graphify-out/', () => {
    const ignore = readFileSync(join(ROOT, '.gitignore'), 'utf8').split('\n');
    expect(ignore).toContain('.beads/');
    expect(ignore).toContain('graphify-out/');
  });

  it('ignores .codex/', () => {
    const ignore = readFileSync(join(ROOT, '.gitignore'), 'utf8').split('\n');
    expect(ignore).toContain('.codex/');
  });

  it('has no graphify merge driver line in .gitattributes', () => {
    expect(readFileSync(join(ROOT, '.gitattributes'), 'utf8')).not.toContain('graphify');
  });

  it('keeps lefthook.yml', () => {
    expect(existsSync(join(ROOT, 'lefthook.yml'))).toBe(true);
  });
});
