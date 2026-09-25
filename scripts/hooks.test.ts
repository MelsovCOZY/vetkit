import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Proves the git hook chain from classified-evals-mol-fou.13: core.hooksPath stays
// .beads/hooks (bd-managed), an advisory `bun x lefthook run <hook>` line runs after
// the BEADS markers (never installed via `lefthook install`, never gates on its exit
// code — CI is the gate per the root DECISION resolving OPEN-3), and the pre-existing
// graphify post-commit block still rebuilds graphify-out/graph.json (AST-only, no LLM)
// within 60s of a commit touching packages/*/src/*.ts.
//
// All git/bd state lives inside a throwaway `git clone` of this worktree, never a
// `git worktree add` (which would redirect bd to the real repo's Dolt database via
// .beads/redirect) and never the real repo's .git/config, .beads/ or hooks.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BEGIN_MARKER = '# --- BEGIN BEADS INTEGRATION v1.2.2 ---';
const END_MARKER = '# --- END BEADS INTEGRATION v1.2.2 ---';

function hasCommand(cmd: string): boolean {
  const result = spawnSync(cmd, ['--version'], { stdio: 'ignore' });
  return result.error === undefined && result.status === 0;
}

const HAS_GRAPHIFY = hasCommand('graphify');

describe('git hook chain: bd markers + advisory lefthook (fou.13)', () => {
  it.each(['pre-commit', 'pre-push'])(
    '%s keeps the BEADS markers intact and appends an advisory, always-exit-0 lefthook call',
    (hookName) => {
      const text = readFileSync(join(ROOT, '.beads/hooks', hookName), 'utf8');

      const beginIdx = text.indexOf(BEGIN_MARKER);
      const endIdx = text.indexOf(END_MARKER);
      expect(beginIdx).toBeGreaterThan(-1);
      expect(endIdx).toBeGreaterThan(beginIdx);

      // Nothing between the markers changed: the bd-managed pre-commit/pre-push shim
      // still runs `bd hooks run <hookName>` inside them.
      const managedBlock = text.slice(beginIdx, endIdx);
      expect(managedBlock).toContain(`bd hooks run ${hookName}`);

      // The lefthook call is appended strictly after the END marker, never inside it.
      const appended = text.slice(endIdx + END_MARKER.length);
      expect(appended).toContain(`lefthook run ${hookName}`);

      // Advisory only: lefthook's exit code must never be propagated (root DECISION
      // resolving OPEN-3 — CI is the gate, not local hooks).
      expect(appended.trim().endsWith('exit 0')).toBe(true);
    },
  );

  const skipReason = HAS_GRAPHIFY ? '' : ' [skipped: graphify not found on PATH]';
  it.skipIf(!HAS_GRAPHIFY)(
    `a commit in a temp clone runs lefthook advisorily and the post-commit graphify rebuild ` +
      `makes a new symbol queryable within 60s${skipReason}`,
    async () => {
      const clonePath = realpathSync(mkdtempSync(join(tmpdir(), 'vetkit-hooks-')));

      try {
        const clone = spawnSync('git', ['clone', '--no-hardlinks', ROOT, clonePath], {
          cwd: tmpdir(),
          encoding: 'utf8',
        });
        expect(clone.status, clone.stderr).toBe(0);

        // core.hooksPath is repo-local git config, not part of the cloned refs/objects,
        // so the clone must set it up the same way bd's own `bd init` did in the real repo.
        spawnSync('git', ['-C', clonePath, 'config', 'core.hooksPath', '.beads/hooks']);
        spawnSync('git', ['-C', clonePath, 'config', 'user.email', 'hooks-test@example.com']);
        spawnSync('git', ['-C', clonePath, 'config', 'user.name', 'Hooks Test']);

        // R1: prove isolation *before* any other bd call — a plain clone (not a git
        // worktree) gets its own fresh Dolt database, never the real repo's.
        const whereOut = spawnSync('bd', ['where'], { cwd: clonePath, encoding: 'utf8' });
        expect(whereOut.status, whereOut.stderr).toBe(0);
        expect(whereOut.stdout).toContain(clonePath);
        expect(whereOut.stdout).not.toContain(ROOT);

        // Fixture lefthook.yml: a command whose output is unmistakable, independent of
        // {staged_files} globbing (lefthook.yml's real contents are owned by fou.10).
        writeFileSync(
          join(clonePath, 'lefthook.yml'),
          'pre-commit:\n  commands:\n    hooks-test-marker:\n      run: echo HOOKS_TEST_MARKER\n',
        );

        const graphPath = join(clonePath, 'graphify-out', 'graph.json');
        const baselineMtimeMs = existsSync(graphPath) ? statSync(graphPath).mtimeMs : 0;

        // Fixture commit touching packages/*/src/*.ts, per the acceptance criterion.
        writeFileSync(
          join(clonePath, 'packages/spec/src/__hooktest__.ts'),
          'export function hookTestSymbol(): number {\n  return 42;\n}\n',
        );
        spawnSync('git', [
          '-C',
          clonePath,
          'add',
          'lefthook.yml',
          'packages/spec/src/__hooktest__.ts',
        ]);
        const commit = spawnSync(
          'git',
          ['-C', clonePath, 'commit', '-m', 'test: hooktest fixture (fou.13)'],
          { encoding: 'utf8' },
        );
        expect(commit.status, commit.stderr + commit.stdout).toBe(0);

        // Advisory lefthook ran and its command's output is visible; also proves the
        // commit was never blocked by lefthook (or its absence).
        expect(commit.stdout + commit.stderr).toContain('HOOKS_TEST_MARKER');

        // The BEADS shim itself still reports installed after the appended line.
        const hooksList = spawnSync('bd', ['hooks', 'list'], { cwd: clonePath, encoding: 'utf8' });
        expect(hooksList.status, hooksList.stderr).toBe(0);
        expect(hooksList.stdout).toMatch(/pre-commit:\s*installed/);
        expect(hooksList.stdout).toMatch(/pre-push:\s*installed/);

        // The detached post-commit rebuild (graphify's own block, not owned by this
        // bead) is AST-only and no-LLM; poll up to the 60s acceptance bound.
        const deadline = Date.now() + 60_000;
        let rebuilt = false;
        while (Date.now() < deadline) {
          if (existsSync(graphPath) && statSync(graphPath).mtimeMs > baselineMtimeMs) {
            rebuilt = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        expect(rebuilt).toBe(true);

        // NOTE: graphify-out's *initial* freshness (criterion 3 — `graphify update .`
        // having been run once against packages/* source) is a manual check per the
        // approved contract, not asserted here; this only proves the chain rebuilds.
        const query = spawnSync('graphify', ['query', 'hookTestSymbol'], {
          cwd: clonePath,
          encoding: 'utf8',
        });
        expect(query.status, query.stderr).toBe(0);
        expect(query.stdout).toContain('hookTestSymbol');
      } finally {
        rmSync(clonePath, { recursive: true, force: true });
      }
    },
    90_000,
  );
});
