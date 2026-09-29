import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
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

  it('leaves the maintainer bd chain alone when a .beads dir exists', () => {
    withRepo((dir) => {
      mkdirSync(join(dir, '.beads', 'hooks'), { recursive: true });
      git(dir, 'config', 'core.hooksPath', '.beads/hooks');
      const run = runInstall(dir);
      expect(run.status, run.stderr + run.stdout).toBe(0);
      expect(git(dir, 'config', '--local', '--get', 'core.hooksPath').out).toBe('.beads/hooks');
      expect(run.stdout + run.stderr).toContain('.beads');
      expect(readdirSync(join(dir, '.git', 'hooks')).includes('pre-commit')).toBe(false);
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
